# Bloom

Automated Liquidity Management

## TODO

- collect fees and rewards before doing pool_token_mint_to_amount calculation in add_liquidity
- collect fees and rewards before burning pool tokens and returning liquidity
- check pool token amount math, its not exact currently
- use multiple positions
- test solving for B?
- make `rebalance_positions` permissionless, how do we check that appropriate ticks are passed in?
- mint performance accuring tokens as rewards for providing liquidity
- optimize the swap, we still have leftover tokens in vault after a rebalance
- `TickArraySequenceInvalid` when swapping in typescript client
- `MisCalculation` during rebalance
- close position mint accounts and send lamports to the vaults
- set a low slippage somehow during the swap
