use anchor_lang::prelude::*;

declare_id!("9ryxeAa6TDqRm8maHYyAi8w6X8KxbY8biXsi279vGJJN");

pub mod errors;
pub mod math;

pub mod instructions;
use instructions::*;

#[program]
pub mod bloom {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        pool_position_mint_seed: String,
        lower_tick_index: i32,
        upper_tick_index: i32,
    ) -> Result<()> {
        instructions::initialize_vault::handler(
            ctx,
            pool_position_mint_seed,
            lower_tick_index,
            upper_tick_index,
        )
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, token_a_amount_in: u64) -> Result<()> {
        instructions::add_liquidity::handler(ctx, token_a_amount_in)
    }

    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>) -> Result<()> {
        instructions::remove_liquidity::handler(ctx)
    }

    pub fn rebalance_positions(
        ctx: Context<RebalancePositions>,
        new_pool_position_mint_seed: String,
        lower_tick_index: i32,
        upper_tick_index: i32,
    ) -> Result<()> {
        instructions::rebalance_positions::handler(
            ctx,
            new_pool_position_mint_seed,
            lower_tick_index,
            upper_tick_index,
        )
    }
}
