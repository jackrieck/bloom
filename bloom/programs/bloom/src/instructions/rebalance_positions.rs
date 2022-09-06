use anchor_lang::prelude::*;
use anchor_lang_for_whirlpool::accounts::account::Account as WhirlpoolAccount;
use anchor_spl::{associated_token, token};
use whirlpool::{
    manager::liquidity_manager::calculate_liquidity_token_deltas,
    math::MAX_SQRT_PRICE_X64,
    math::{sqrt_price_from_tick_index, MIN_SQRT_PRICE_X64},
    state::Position as WhirlpoolPosition,
};
use whirlpools::cpi::{
    accounts::{
        ClosePosition, CollectFees, DecreaseLiquidity, IncreaseLiquidity, OpenPosition, Swap,
    },
    {
        close_position, collect_fees, decrease_liquidity, increase_liquidity, open_position,
        swap as whirlpool_swap,
    },
};
use whirlpools::program::Whirlpool as WhirlpoolProgram;
use whirlpools::state::{TickArray, Whirlpool};
use whirlpools::OpenPositionBumps;

use super::*;
use crate::errors::BloomErrorCode;
use crate::math;

#[derive(Accounts)]
#[instruction(new_pool_position_mint_seed: String)]
pub struct RebalancePositions<'info> {
    #[account(mut,
        seeds = [pool.key().as_ref()], bump,
        has_one = token_a,
        has_one = token_b,
        has_one = token_a_vault,
        has_one = token_b_vault,
        has_one = pool,
        has_one = token_a_pool_vault,
        has_one = token_b_pool_vault)]
    pub vault_manager: Box<Account<'info, VaultManager>>,

    pub token_a: Box<Account<'info, token::Mint>>,

    pub token_b: Box<Account<'info, token::Mint>>,

    #[account(mut, seeds = [vault_manager.key().as_ref(), token_a.key().as_ref()], bump, token::mint = token_a, token::authority = vault_manager)]
    pub token_a_vault: Box<Account<'info, token::TokenAccount>>,

    #[account(mut, seeds = [vault_manager.key().as_ref(), token_b.key().as_ref()], bump, token::mint = token_b, token::authority = vault_manager)]
    pub token_b_vault: Box<Account<'info, token::TokenAccount>>,

    #[account(mut)]
    pub pool: Box<Account<'info, Whirlpool>>,

    #[account(mut, token::mint = token_a)]
    pub token_a_pool_vault: Box<Account<'info, token::TokenAccount>>,

    #[account(mut, token::mint = token_b)]
    pub token_b_pool_vault: Box<Account<'info, token::TokenAccount>>,

    /// CHECK: serialized inside instruction
    #[account(mut, seeds = [b"position", old_pool_position_mint.key().as_ref()], bump, seeds::program = whirlpool_program)]
    pub old_pool_position: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"pool_position_mint", vault_manager.pool_position_mint_seed.as_bytes(), pool.key().as_ref()], bump)]
    pub old_pool_position_mint: Account<'info, token::Mint>,

    #[account(mut, token::mint = old_pool_position_mint, token::authority = vault_manager)]
    pub old_pool_position_token_account: Account<'info, token::TokenAccount>,

    #[account(mut)]
    pub old_tick_array_lower: AccountLoader<'info, TickArray>,

    #[account(mut)]
    pub old_tick_array_upper: AccountLoader<'info, TickArray>,

    #[account(mut)]
    pub new_tick_array_lower: AccountLoader<'info, TickArray>,

    #[account(mut)]
    pub tick_array_current: AccountLoader<'info, TickArray>,

    #[account(mut)]
    pub new_tick_array_upper: AccountLoader<'info, TickArray>,

    /// CHECK: Must be provided for swapping but not currently used by Whirlpool Program
    #[account(seeds = [b"oracle", pool.key().as_ref()], bump, seeds::program = whirlpool_program)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: initialized by whirlpool program
    #[account(mut, seeds = [b"position", new_pool_position_mint.key().as_ref()], bump, seeds::program = whirlpool_program)]
    pub new_pool_position: UncheckedAccount<'info>,

    /// CHECK: initialized by whirlpool program
    #[account(mut, seeds = [b"pool_position_mint", new_pool_position_mint_seed.as_bytes(), pool.key().as_ref()], bump)]
    pub new_pool_position_mint: UncheckedAccount<'info>,

    /// CHECK: initialized by whirlpool program
    #[account(mut)]
    pub new_pool_position_token_account: UncheckedAccount<'info>,

    #[account(mut)]
    pub crank: Signer<'info>,

    pub token_program: Program<'info, token::Token>,
    pub whirlpool_program: Program<'info, WhirlpoolProgram>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    pub associated_token_program: Program<'info, associated_token::AssociatedToken>,
}

pub fn handler(
    ctx: Context<RebalancePositions>,
    new_pool_position_mint_seed: String,
    lower_tick_index: i32,
    upper_tick_index: i32,
) -> Result<()> {
    // Have to do this hacky thing because of anchor-lang version mismatch
    let old_pool_position =
        &mut WhirlpoolAccount::<'_, WhirlpoolPosition>::try_from(&ctx.accounts.old_pool_position)?;

    let tick_index_lower = old_pool_position.tick_lower_index;
    let tick_index_upper = old_pool_position.tick_upper_index;
    let tick_index_current = ctx.accounts.pool.tick_current_index;

    // if the position is in range then return without error
    if position_in_range(tick_index_current, tick_index_lower, tick_index_upper) {
        msg!("position in range, no rebalance");
        let lower_price = math::sqrt_price_x64_to_price(
            sqrt_price_from_tick_index(old_pool_position.tick_lower_index),
            ctx.accounts.token_a.decimals,
            ctx.accounts.token_b.decimals,
        );
        let upper_price = math::sqrt_price_x64_to_price(
            sqrt_price_from_tick_index(old_pool_position.tick_upper_index),
            ctx.accounts.token_a.decimals,
            ctx.accounts.token_b.decimals,
        );
        let current_price = math::sqrt_price_x64_to_price(
            ctx.accounts.pool.sqrt_price,
            ctx.accounts.token_a.decimals,
            ctx.accounts.token_b.decimals,
        );
        emit!(PositionInRange {
            lower_price: lower_price,
            current_price: current_price,
            upper_price: upper_price,
        });
        return Ok(());
    }

    // TODO: collect rewards

    msg!(
        "old_pool_position: liquidity: {}, fee_owed_a: {}, fee_owed_b: {}, reward_infos: {:?}",
        old_pool_position.liquidity,
        old_pool_position.fee_owed_a,
        old_pool_position.fee_owed_b,
        old_pool_position.reward_infos
    );

    // decrease liquidity
    let decrease_liquidity_accounts = DecreaseLiquidity {
        whirlpool: ctx.accounts.pool.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        position_authority: ctx.accounts.vault_manager.to_account_info(),
        position: ctx.accounts.old_pool_position.to_account_info(),
        position_token_account: ctx
            .accounts
            .old_pool_position_token_account
            .to_account_info(),
        token_owner_account_a: ctx.accounts.token_a_vault.to_account_info(),
        token_owner_account_b: ctx.accounts.token_b_vault.to_account_info(),
        token_vault_a: ctx.accounts.token_a_pool_vault.to_account_info(),
        token_vault_b: ctx.accounts.token_b_pool_vault.to_account_info(),
        tick_array_lower: ctx.accounts.old_tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.old_tick_array_upper.to_account_info(),
    };

    // TODO: is this the right way to do it
    decrease_liquidity(
        CpiContext::new_with_signer(
            ctx.accounts.whirlpool_program.to_account_info(),
            decrease_liquidity_accounts,
            &[&[
                ctx.accounts.pool.key().as_ref(),
                &[*ctx.bumps.get("vault_manager").unwrap()],
            ]],
        ),
        old_pool_position.liquidity,
        0,
        0,
    )?;
    old_pool_position.reload().unwrap();
    msg!(
        "old_pool_position: liquidity: {}, fee_owed_a: {}, fee_owed_b: {}, reward_infos: {:?}",
        old_pool_position.liquidity,
        old_pool_position.fee_owed_a,
        old_pool_position.fee_owed_b,
        old_pool_position.reward_infos
    );

    // collect fees
    let collect_fees_accounts = CollectFees {
        whirlpool: ctx.accounts.pool.to_account_info(),
        position_authority: ctx.accounts.vault_manager.to_account_info(),
        position: ctx.accounts.old_pool_position.to_account_info(),
        position_token_account: ctx
            .accounts
            .old_pool_position_token_account
            .to_account_info(),
        token_owner_account_a: ctx.accounts.token_a_vault.to_account_info(),
        token_vault_a: ctx.accounts.token_a_pool_vault.to_account_info(),
        token_owner_account_b: ctx.accounts.token_b_vault.to_account_info(),
        token_vault_b: ctx.accounts.token_b_pool_vault.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };

    collect_fees(CpiContext::new_with_signer(
        ctx.accounts.whirlpool_program.to_account_info(),
        collect_fees_accounts,
        &[&[
            ctx.accounts.pool.key().as_ref(),
            &[*ctx.bumps.get("vault_manager").unwrap()],
        ]],
    ))?;

    ctx.accounts.token_a_vault.reload().unwrap();
    ctx.accounts.token_b_vault.reload().unwrap();

    msg!(
        "after decrease_position\tvault_a: {}, vault_b: {}",
        ctx.accounts.token_a_vault.amount,
        ctx.accounts.token_b_vault.amount
    );

    // close position
    let close_position_accounts = ClosePosition {
        position: ctx.accounts.old_pool_position.to_account_info(),
        receiver: ctx.accounts.crank.to_account_info(),
        position_mint: ctx.accounts.old_pool_position_mint.to_account_info(),
        position_token_account: ctx
            .accounts
            .old_pool_position_token_account
            .to_account_info(),
        position_authority: ctx.accounts.vault_manager.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };

    close_position(CpiContext::new_with_signer(
        ctx.accounts.whirlpool_program.to_account_info(),
        close_position_accounts,
        &[&[
            ctx.accounts.pool.key().as_ref(),
            &[*ctx.bumps.get("vault_manager").unwrap()],
        ]],
    ))?;

    msg!("opening new position");

    // open new position
    let open_position_accounts = OpenPosition {
        funder: ctx.accounts.crank.to_account_info(),
        owner: ctx.accounts.vault_manager.to_account_info(),
        position: ctx.accounts.new_pool_position.to_account_info(),
        position_mint: ctx.accounts.new_pool_position_mint.to_account_info(),
        position_token_account: ctx
            .accounts
            .new_pool_position_token_account
            .to_account_info(),
        whirlpool: ctx.accounts.pool.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        rent: ctx.accounts.rent.to_account_info(),
        associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
    };

    open_position(
        CpiContext::new_with_signer(
            ctx.accounts.whirlpool_program.to_account_info(),
            open_position_accounts,
            &[&[
                b"pool_position_mint",
                new_pool_position_mint_seed.as_bytes(),
                ctx.accounts.pool.key().as_ref(),
                &[*ctx.bumps.get("new_pool_position_mint").unwrap()],
            ]],
        ),
        OpenPositionBumps {
            position_bump: *ctx.bumps.get("new_pool_position").unwrap(),
        },
        lower_tick_index,
        upper_tick_index,
    )?;

    let new_pool_position =
        &mut WhirlpoolAccount::<'_, WhirlpoolPosition>::try_from(&ctx.accounts.new_pool_position)?;

    // check that our position is within range of the pool
    if tick_index_current < new_pool_position.tick_lower_index
        || tick_index_current >= new_pool_position.tick_upper_index
    {
        return Err(error!(BloomErrorCode::PositionOutOfRange));
    };

    // calculate deposit ratio of position
    let lower_price = math::sqrt_price_x64_to_price(
        sqrt_price_from_tick_index(new_pool_position.tick_lower_index),
        ctx.accounts.token_a.decimals,
        ctx.accounts.token_b.decimals,
    );
    let upper_price = math::sqrt_price_x64_to_price(
        sqrt_price_from_tick_index(new_pool_position.tick_upper_index),
        ctx.accounts.token_a.decimals,
        ctx.accounts.token_b.decimals,
    );
    let current_price = math::sqrt_price_x64_to_price(
        ctx.accounts.pool.sqrt_price,
        ctx.accounts.token_a.decimals,
        ctx.accounts.token_b.decimals,
    );
    let (token_a_percentage, token_b_percentage) =
        math::calculate_deposit_ratio(lower_price, current_price, upper_price);
    msg!(
        "deposit_ratio\tA: {}% B: {}%",
        token_a_percentage,
        token_b_percentage
    );

    // determine which token we need more of
    let token_a_amount = math::amount_to_ui_amount(
        ctx.accounts.token_a_vault.amount,
        ctx.accounts.token_a.decimals,
    );
    let token_b_amount = math::amount_to_ui_amount(
        ctx.accounts.token_b_vault.amount,
        ctx.accounts.token_b.decimals,
    );
    let token_b_leftover_amount = math::calculate_token_b_leftover(
        token_a_percentage,
        token_b_percentage,
        token_a_amount,
        token_b_amount,
        current_price,
    );
    let token_a_leftover_amount = math::calculate_token_a_leftover(
        token_a_percentage,
        token_b_percentage,
        token_a_amount,
        token_b_amount,
        current_price,
    );

    let swap_accounts = Swap {
        token_program: ctx.accounts.token_program.to_account_info(),
        token_authority: ctx.accounts.vault_manager.to_account_info(),
        whirlpool: ctx.accounts.pool.to_account_info(),
        token_owner_account_a: ctx.accounts.token_a_vault.to_account_info(),
        token_owner_account_b: ctx.accounts.token_b_vault.to_account_info(),
        token_vault_a: ctx.accounts.token_a_pool_vault.to_account_info(),
        token_vault_b: ctx.accounts.token_b_pool_vault.to_account_info(),
        tick_array0: ctx.accounts.tick_array_current.to_account_info(),
        tick_array1: ctx.accounts.tick_array_current.to_account_info(),
        tick_array2: ctx.accounts.tick_array_current.to_account_info(),
        oracle: ctx.accounts.oracle.to_account_info(),
    };

    let pool_key = ctx.accounts.pool.key();
    let vault_manager_seeds: &[&[&[u8]]] = &[&[
        pool_key.as_ref(),
        &[*ctx.bumps.get("vault_manager").unwrap()],
    ]];

    if token_b_leftover_amount > 0.0 {
        msg!("need to swap token B for token A");
        let token_b_max_out = math::ui_amount_to_amount(
            math::calculate_token_b_swap_amount(token_b_percentage, token_b_leftover_amount),
            ctx.accounts.token_b.decimals,
        );
        msg!("token_b_max_out: {}", token_b_max_out);

        let a_to_b = false;

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.whirlpool_program.to_account_info(),
            swap_accounts,
            vault_manager_seeds,
        );

        swap(
            cpi_ctx,
            token_b_max_out,
            0,
            MAX_SQRT_PRICE_X64,
            true,
            a_to_b,
        )?;
    } else {
        msg!("need to swap token A for token B");
        let token_a_max_out = math::ui_amount_to_amount(
            math::calculate_token_a_swap_amount(token_a_percentage, token_a_leftover_amount),
            ctx.accounts.token_a.decimals,
        );
        msg!("token_a_max_out: {}", token_a_max_out);

        let a_to_b = true;

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.whirlpool_program.to_account_info(),
            swap_accounts,
            vault_manager_seeds,
        );

        swap(
            cpi_ctx,
            token_a_max_out,
            0,
            MIN_SQRT_PRICE_X64,
            true,
            a_to_b,
        )?;
    }

    // reload to get correct amounts after swap
    ctx.accounts.token_a_vault.reload().unwrap();
    ctx.accounts.token_b_vault.reload().unwrap();
    ctx.accounts.pool.reload().unwrap();

    msg!(
        "after_swap:\ttoken_a_vault: {}, token_b_vault: {}",
        ctx.accounts.token_a_vault.amount,
        ctx.accounts.token_b_vault.amount
    );

    let sqrt_price_current_x64 = ctx.accounts.pool.sqrt_price;
    let sqrt_price_upper_x64 = sqrt_price_from_tick_index(new_pool_position.tick_upper_index);

    let liquidity = math::get_liquidity_from_token_a(
        ctx.accounts.token_a_vault.amount as u128,
        sqrt_price_current_x64,
        sqrt_price_upper_x64,
    );

    let (token_max_a, token_max_b) = calculate_liquidity_token_deltas(
        tick_index_current,
        sqrt_price_current_x64,
        &new_pool_position,
        liquidity as i128,
    )
    .unwrap();

    msg!(
        "liquidity: {}, token_max_a: {}, token_max_b: {}",
        liquidity,
        token_max_a,
        token_max_b,
    );

    if token_max_b > ctx.accounts.token_b_vault.amount {
        msg!("not enough of token_b in vault");
        return Err(error!(BloomErrorCode::Miscalculation));
    };

    if token_max_a > ctx.accounts.token_a_vault.amount {
        msg!("not enough of token_a in vault");
        return Err(error!(BloomErrorCode::Miscalculation));
    }

    // add liquidity back into the new position
    let increase_liquidity_accounts = IncreaseLiquidity {
        whirlpool: ctx.accounts.pool.to_account_info(),
        position: ctx.accounts.new_pool_position.to_account_info(),
        position_authority: ctx.accounts.vault_manager.to_account_info(),
        position_token_account: ctx
            .accounts
            .new_pool_position_token_account
            .to_account_info(),
        tick_array_lower: ctx.accounts.new_tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.new_tick_array_upper.to_account_info(),
        token_owner_account_a: ctx.accounts.token_a_vault.to_account_info(),
        token_owner_account_b: ctx.accounts.token_b_vault.to_account_info(),
        token_vault_a: ctx.accounts.token_a_pool_vault.to_account_info(),
        token_vault_b: ctx.accounts.token_b_pool_vault.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };

    increase_liquidity(
        CpiContext::new_with_signer(
            ctx.accounts.whirlpool_program.to_account_info(),
            increase_liquidity_accounts,
            &[&[
                ctx.accounts.pool.key().as_ref(),
                &[*ctx.bumps.get("vault_manager").unwrap()],
            ]],
        ),
        liquidity,
        token_max_a,
        token_max_b,
    )?;

    ctx.accounts.token_a_vault.reload().unwrap();
    ctx.accounts.token_b_vault.reload().unwrap();

    msg!(
        "after increase_liquidity\tvault_a: {}, vault_b: {}",
        ctx.accounts.token_a_vault.amount,
        ctx.accounts.token_b_vault.amount
    );

    // update vault_manager fields with new positions
    let vault_manager = &mut ctx.accounts.vault_manager;
    vault_manager.pool_position = ctx.accounts.new_pool_position.key();
    vault_manager.pool_position_mint = ctx.accounts.new_pool_position_mint.key();
    vault_manager.pool_position_token_account = ctx.accounts.new_pool_position_token_account.key();

    Ok(())
}

fn swap<'info>(
    cpi_ctx: CpiContext<'_, '_, '_, 'info, Swap<'info>>,
    amount: u64,
    other_amount_threshold: u64,
    sqrt_price_limit: u128,
    amount_specified_is_input: bool,
    a_to_b: bool,
) -> Result<()> {
    whirlpool_swap(
        cpi_ctx,
        amount,
        other_amount_threshold,
        sqrt_price_limit,
        amount_specified_is_input,
        a_to_b,
    )
}

fn position_in_range(
    tick_index_current: i32,
    tick_index_lower: i32,
    tick_index_upper: i32,
) -> bool {
    if tick_index_current < tick_index_lower || tick_index_upper <= tick_index_current {
        return false;
    }

    return true;
}

#[event]
pub struct PositionInRange {
    pub lower_price: f64,
    pub current_price: f64,
    pub upper_price: f64,
}
