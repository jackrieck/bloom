use anchor_lang::prelude::*;
use anchor_spl::{associated_token, token};
use whirlpools::cpi::{accounts::OpenPosition, open_position};
use whirlpools::program::Whirlpool as WhirlpoolProgram;
use whirlpools::state::Whirlpool;
use whirlpools::OpenPositionBumps;

#[derive(Accounts)]
#[instruction(pool_position_mint_seed: String)]
pub struct InitializeVault<'info> {
    #[account(init, payer = admin, space = VaultManager::space(), seeds = [pool.key().as_ref()], bump)]
    pub vault_manager: Box<Account<'info, VaultManager>>,

    pub token_a: Box<Account<'info, token::Mint>>,

    pub token_b: Box<Account<'info, token::Mint>>,

    #[account(init, payer = admin, seeds = [b"pool_token", vault_manager.key().as_ref()], bump, mint::decimals = 9, mint::authority = vault_manager)]
    pub pool_token: Box<Account<'info, token::Mint>>,

    #[account(init, payer = admin, seeds = [vault_manager.key().as_ref(), token_a.key().as_ref()], bump, token::mint = token_a, token::authority = vault_manager)]
    pub token_a_vault: Box<Account<'info, token::TokenAccount>>,

    #[account(init, payer = admin, seeds = [vault_manager.key().as_ref(), token_b.key().as_ref()], bump, token::mint = token_b, token::authority = vault_manager)]
    pub token_b_vault: Box<Account<'info, token::TokenAccount>>,

    pub pool: Box<Account<'info, Whirlpool>>,

    /// CHECK: initialized by the Whirlpool Program
    #[account(mut, seeds = [b"position", pool_position_mint.key().as_ref()], bump, seeds::program = whirlpool_program)]
    pub pool_position: UncheckedAccount<'info>,

    /// CHECK: initialized by the Whirlpool Program
    #[account(mut, seeds = [b"pool_position_mint", pool_position_mint_seed.as_bytes(), pool.key().as_ref()], bump)]
    pub pool_position_mint: UncheckedAccount<'info>,

    /// CHECK: initialized by the Whirlpool Program
    #[account(mut)]
    pub pool_position_token_account: UncheckedAccount<'info>,

    #[account(token::mint = token_a)]
    pub token_a_pool_vault: Account<'info, token::TokenAccount>,

    #[account(token::mint = token_b)]
    pub token_b_pool_vault: Account<'info, token::TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub whirlpool_program: Program<'info, WhirlpoolProgram>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, token::Token>,
    pub rent: Sysvar<'info, Rent>,
    pub associated_token_program: Program<'info, associated_token::AssociatedToken>,
}

#[account]
pub struct VaultManager {
    pub token_a: Pubkey,
    pub token_b: Pubkey,
    pub pool_token: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub pool: Pubkey,
    pub token_a_pool_vault: Pubkey,
    pub token_b_pool_vault: Pubkey,
    pub pool_position: Pubkey,
    pub pool_position_mint: Pubkey,
    pub pool_position_mint_seed: String,
    pub pool_position_token_account: Pubkey,
    pub admin: Pubkey,
}

impl VaultManager {
    pub fn space() -> usize {
        8 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + (4 + 6) + 32 + 32
    }
}

pub fn handler(
    ctx: Context<InitializeVault>,
    pool_position_mint_seed: String,
    lower_tick_index: i32,
    upper_tick_index: i32,
) -> Result<()> {
    let open_position_accounts = OpenPosition {
        funder: ctx.accounts.admin.to_account_info(),
        owner: ctx.accounts.vault_manager.to_account_info(),
        position: ctx.accounts.pool_position.to_account_info(),
        position_mint: ctx.accounts.pool_position_mint.to_account_info(),
        position_token_account: ctx.accounts.pool_position_token_account.to_account_info(),
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
                pool_position_mint_seed.as_bytes(),
                ctx.accounts.pool.key().as_ref(),
                &[*ctx.bumps.get("pool_position_mint").unwrap()],
            ]],
        ),
        OpenPositionBumps {
            position_bump: *ctx.bumps.get("pool_position").unwrap(),
        },
        lower_tick_index,
        upper_tick_index,
    )?;

    let vault_manager = &mut ctx.accounts.vault_manager;

    vault_manager.token_a = ctx.accounts.token_a.key();
    vault_manager.token_b = ctx.accounts.token_b.key();
    vault_manager.pool_token = ctx.accounts.pool_token.key();
    vault_manager.token_a_vault = ctx.accounts.token_a_vault.key();
    vault_manager.token_b_vault = ctx.accounts.token_b_vault.key();
    vault_manager.pool = ctx.accounts.pool.key();
    vault_manager.token_a_pool_vault = ctx.accounts.token_a_pool_vault.key();
    vault_manager.token_b_pool_vault = ctx.accounts.token_b_pool_vault.key();
    vault_manager.pool_position = ctx.accounts.pool_position.key();
    vault_manager.pool_position_mint = ctx.accounts.pool_position_mint.key();
    vault_manager.pool_position_mint_seed = pool_position_mint_seed;
    vault_manager.pool_position_token_account = ctx.accounts.pool_position_token_account.key();
    vault_manager.admin = ctx.accounts.admin.key();

    Ok(())
}
