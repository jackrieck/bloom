use anchor_lang::prelude::*;
use anchor_lang_for_whirlpool::accounts::account::Account as WhirlpoolAccount;
use anchor_spl::token;
use whirlpool::state::Position as WhirlpoolPosition;
use whirlpools::cpi::{accounts::DecreaseLiquidity, decrease_liquidity};
use whirlpools::program::Whirlpool as WhirlpoolProgram;
use whirlpools::state::{TickArray, Whirlpool};

use super::*;
use crate::math;

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(seeds = [pool.key().as_ref()], bump,
    has_one = pool_position,
    has_one = pool_position_token_account,
    has_one = pool,
    has_one = pool_token,
    has_one = token_a,
    has_one = token_b,
    has_one = token_a_pool_vault,
    has_one = token_b_pool_vault)]
    pub vault_manager: Box<Account<'info, VaultManager>>,

    pub token_a: Box<Account<'info, token::Mint>>,

    pub token_b: Box<Account<'info, token::Mint>>,

    #[account(mut, seeds = [b"pool_token", vault_manager.key().as_ref()], bump)]
    pub pool_token: Box<Account<'info, token::Mint>>,

    #[account(mut)]
    pub pool: Box<Account<'info, Whirlpool>>,

    #[account(mut, token::mint = token_a)]
    pub token_a_pool_vault: Box<Account<'info, token::TokenAccount>>,

    #[account(mut, token::mint = token_b)]
    pub token_b_pool_vault: Box<Account<'info, token::TokenAccount>>,

    /// CHECK: deserialized inside instruction
    #[account(mut, seeds = [b"position", pool_position_mint.key().as_ref()], bump, seeds::program = whirlpool_program)]
    pub pool_position: UncheckedAccount<'info>,

    #[account(seeds = [b"pool_position_mint", vault_manager.pool_position_mint_seed.as_bytes(), pool.key().as_ref()], bump)]
    pub pool_position_mint: Box<Account<'info, token::Mint>>,

    #[account(token::mint = pool_position_mint, token::authority = vault_manager)]
    pub pool_position_token_account: Account<'info, token::TokenAccount>,

    #[account(mut)]
    pub tick_array_lower: AccountLoader<'info, TickArray>,

    #[account(mut)]
    pub tick_array_upper: AccountLoader<'info, TickArray>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, token::mint = token_a, token::authority = user)]
    pub user_token_a_ata: Account<'info, token::TokenAccount>,

    #[account(mut, token::mint = token_b, token::authority = user)]
    pub user_token_b_ata: Account<'info, token::TokenAccount>,

    #[account(mut, associated_token::mint = pool_token, associated_token::authority = user)]
    pub user_pool_token_ata: Account<'info, token::TokenAccount>,

    pub token_program: Program<'info, token::Token>,
    pub whirlpool_program: Program<'info, WhirlpoolProgram>,
}

pub fn handler(ctx: Context<RemoveLiquidity>) -> Result<()> {
    // Have to do this hacky thing because of anchor-lang version mismatch
    let pool_position =
        &mut WhirlpoolAccount::<'_, WhirlpoolPosition>::try_from(&ctx.accounts.pool_position)?;

    let tick_index_lower = pool_position.tick_lower_index;
    let tick_index_upper = pool_position.tick_upper_index;
    let tick_index_current = ctx.accounts.pool.tick_current_index;

    // check that our position is within range of the pool
    if tick_index_current < tick_index_lower || tick_index_current >= tick_index_upper {
        return Ok(());
    }

    //let sqrt_price_current_x64 = ctx.accounts.pool.sqrt_price;
    //let sqrt_price_upper_x64 = sqrt_price_from_tick_index(tick_index_upper);

    //let liquidity = get_liquidity_from_token_a(
    //    token_a_amount_out as u128,
    //    sqrt_price_current_x64,
    //    sqrt_price_upper_x64,
    //);
    //msg!("liquidity: {}", liquidity,);

    let decrease_liquidity_accounts = DecreaseLiquidity {
        whirlpool: ctx.accounts.pool.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        position_authority: ctx.accounts.vault_manager.to_account_info(),
        position: pool_position.to_account_info(),
        position_token_account: ctx.accounts.pool_position_token_account.to_account_info(),
        token_owner_account_a: ctx.accounts.user_token_a_ata.to_account_info(),
        token_owner_account_b: ctx.accounts.user_token_b_ata.to_account_info(),
        token_vault_a: ctx.accounts.token_a_pool_vault.to_account_info(),
        token_vault_b: ctx.accounts.token_b_pool_vault.to_account_info(),
        tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.tick_array_upper.to_account_info(),
    };

    let liquidity = math::calculate_remove_liquidity_amount(
        ctx.accounts.user_pool_token_ata.amount,
        ctx.accounts.pool_token.supply,
        pool_position.liquidity,
    );
    msg!("liquidity_to_remove: {}", liquidity);

    decrease_liquidity(
        CpiContext::new_with_signer(
            ctx.accounts.whirlpool_program.to_account_info(),
            decrease_liquidity_accounts,
            &[&[
                ctx.accounts.pool.key().as_ref(),
                &[*ctx.bumps.get("vault_manager").unwrap()],
            ]],
        ),
        liquidity,
        0,
        0,
    )?;

    pool_position.reload().unwrap();
    msg!(
        "pool_position_liquidity_after_withdraw: {}",
        pool_position.liquidity
    );

    // approve vault manager to burn the pool tokens
    let pool_token_burn_approve_accounts = token::Approve {
        to: ctx.accounts.user_pool_token_ata.to_account_info(),
        delegate: ctx.accounts.vault_manager.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };

    token::approve(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            pool_token_burn_approve_accounts,
        ),
        ctx.accounts.user_pool_token_ata.amount,
    )?;

    let pool_token_burn_accounts = token::Burn {
        mint: ctx.accounts.pool_token.to_account_info(),
        from: ctx.accounts.user_pool_token_ata.to_account_info(),
        authority: ctx.accounts.vault_manager.to_account_info(),
    };

    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            pool_token_burn_accounts,
            &[&[
                ctx.accounts.pool.key().as_ref(),
                &[*ctx.bumps.get("vault_manager").unwrap()],
            ]],
        ),
        ctx.accounts.user_pool_token_ata.amount,
    )
}
