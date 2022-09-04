use anchor_lang::prelude::msg;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::MathematicalOps;
use rust_decimal::{prelude::FromPrimitive, Decimal};
use std::ops::{Div, Mul};

use whirlpool::math::{mul_u256, U256Muldiv};

// convert square root price to decimal
pub fn sqrt_price_x64_to_price(sqrt_price: u128, decimals_a: u8, decimals_b: u8) -> f64 {
    let sqrt_price_decimal = Decimal::from_u128(sqrt_price).unwrap();
    let p = Decimal::from_f64(2.0).unwrap().checked_powf(-64.0).unwrap();
    let from_x64 = sqrt_price_decimal.mul(p);

    let dec_pow2 = from_x64.powf(2.0);
    let base = Decimal::from_u64(10).unwrap();
    let f =
        base.powd(Decimal::from_u8(decimals_a).unwrap() - Decimal::from_u8(decimals_b).unwrap());
    dec_pow2.mul(f).to_f64().unwrap()
}

// returns max amount of token_a to use in a swap
pub fn calculate_token_a_swap_amount(
    token_a_deposit_percentage: f64,
    token_a_leftover: f64,
) -> f64 {
    (token_a_deposit_percentage.mul(0.01)).mul(token_a_leftover)
}

// returns max amount of token_b to use in a swap
pub fn calculate_token_b_swap_amount(
    token_b_deposit_percentage: f64,
    token_b_leftover: f64,
) -> f64 {
    (token_b_deposit_percentage.mul(0.01)).mul(token_b_leftover)
}

// returns how much of token_a is leftover at a given deposit ratio
pub fn calculate_token_a_leftover(
    token_a_deposit_percentage: f64,
    token_b_deposit_percentage: f64,
    token_a_amount: f64,
    token_b_amount: f64,
    current_price: f64,
) -> f64 {
    let div_percentage = token_a_deposit_percentage.div(token_b_deposit_percentage);
    let div_mul = div_percentage.mul(token_b_amount);
    let f = div_mul.mul((1.0 as f64).div(current_price));
    let leftover = token_a_amount - f;
    println!("{}, {}", f, leftover);
    leftover
}

// returns how much of token_b is leftover at a given deposit ratio
pub fn calculate_token_b_leftover(
    token_a_deposit_percentage: f64,
    token_b_deposit_percentage: f64,
    token_a_amount: f64,
    token_b_amount: f64,
    current_price: f64,
) -> f64 {
    let div_percentages = token_b_deposit_percentage.div(token_a_deposit_percentage);
    let div_percentages_mul = div_percentages.mul(token_a_amount);
    let f = div_percentages_mul.mul(current_price);
    let leftover = token_b_amount - f;
    println!("{}, {}", f, leftover);
    leftover
}

// calculate the deposit ratio for a position
// current_price in token b per token a, ex SOL/USDC the current price is N USDC per SOL
pub fn calculate_deposit_ratio(
    lower_price: f64,
    current_price: f64,
    upper_price: f64,
) -> (f64, f64) {
    let a = upper_price.sqrt() - current_price.sqrt();
    let b = current_price
        .sqrt()
        .mul(upper_price.sqrt())
        .mul(current_price.sqrt() - lower_price.sqrt());

    let one: f64 = 1.0;

    let a_scaled = a.mul(current_price.div(one + current_price));
    let b_scaled = b.mul(one.div(one + current_price));

    let a_percentage = a_scaled.div(a_scaled + b_scaled);
    let b_percentage = b_scaled.div(b_scaled + a_scaled);
    println!(
        "{} {} {} {} {} {}",
        a, b, a_scaled, b_scaled, a_percentage, b_percentage
    );

    (a_percentage.mul(100.0), b_percentage.mul(100.0))
}

// https://github.com/everlastingsong/solsandbox/blob/0fc97337c8da8d8315df575ce526405e08ddf0dd/orca/whirlpool/rust_cpi/cpi_whirlpool_increase_liquidity/programs/cpi_whirlpool_increase_liquidity/src/lib.rs#L139
pub fn get_liquidity_from_token_a(
    amount: u128,
    sqrt_price_lower_x64: u128,
    sqrt_price_upper_x64: u128,
) -> u128 {
    // Δa = liquidity/sqrt_price_lower - liquidity/sqrt_price_upper
    // liquidity = Δa * ((sqrt_price_lower * sqrt_price_upper) / (sqrt_price_upper - sqrt_price_lower))
    assert!(sqrt_price_lower_x64 < sqrt_price_upper_x64);
    let sqrt_price_diff = sqrt_price_upper_x64 - sqrt_price_lower_x64;

    let numerator = mul_u256(sqrt_price_lower_x64, sqrt_price_upper_x64); // x64 * x64
    let denominator = U256Muldiv::new(0, sqrt_price_diff); // x64

    let (quotient, _remainder) = numerator.div(denominator, false);

    let liquidity = quotient
        .mul(U256Muldiv::new(0, amount))
        .shift_word_right()
        .try_into_u128()
        .unwrap();

    liquidity
}

pub fn calculate_pool_token_mint_to_amount(
    liquidity_to_deposit: u128,
    position_liquidity_before_deposit: u128,
    pool_token_supply: u64,
) -> u64 {
    // no tokens are minted, so mint the liquidity amount
    if pool_token_supply == 0 {
        msg!("first deposit into vault");
        return liquidity_to_deposit as u64;
    };

    // get percentage of deposit compared to total position amount (current deposit included)
    let liquidity_deposit_percentage: f64 =
        liquidity_to_deposit as f64 / position_liquidity_before_deposit as f64;

    msg!(
        "liquidity_deposit_percentage: {}",
        liquidity_deposit_percentage
    );

    msg!("pool_token_supply: {}", pool_token_supply);

    let mint_to_amount = Decimal::from_u64(pool_token_supply)
        .unwrap()
        .checked_mul(Decimal::from_f64(liquidity_deposit_percentage).unwrap())
        .unwrap();

    msg!("mint_to_amount: {}", mint_to_amount.to_u128().unwrap());

    mint_to_amount.to_u64().unwrap()
}

pub fn calculate_remove_liquidity_amount(
    user_pool_tokens_amount: u64,
    pool_token_supply: u64,
    position_liquidity: u128,
) -> u128 {
    let percentage_of_position: f64 = user_pool_tokens_amount as f64 / pool_token_supply as f64;

    Decimal::from_u128(position_liquidity)
        .unwrap()
        .checked_mul(Decimal::from_f64(percentage_of_position).unwrap())
        .unwrap()
        .to_u128()
        .unwrap()
}

// lifted from spl-token
pub fn amount_to_ui_amount(amount: u64, decimals: u8) -> f64 {
    amount as f64 / 10_usize.pow(decimals as u32) as f64
}

// lifted from spl-token
pub fn ui_amount_to_amount(ui_amount: f64, decimals: u8) -> u64 {
    (ui_amount * 10_usize.pow(decimals as u32) as f64) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculate_token_a_swap_amount1() {
        let swap_amount = calculate_token_a_swap_amount(48.983524007944307, 1.2752598514643663);
        assert_eq!(swap_amount, 0.6246672155057228);
    }

    #[test]
    fn calculate_token_b_swap_amount1() {
        let swap_amount = calculate_token_b_swap_amount(51.0164759920557, 58.14378043006825);
        assert_eq!(swap_amount, 29.662907783979346);
    }

    #[test]
    fn token_a_leftover() {
        let leftover =
            calculate_token_a_leftover(48.983524007944307, 51.0164759920557, 2.5, 45.0, 35.278339);
        assert_eq!(leftover, 1.2752598514643665)
    }

    #[test]
    fn token_b_leftover() {
        let leftover =
            calculate_token_b_leftover(48.983524007944307, 51.0164759920557, 2.5, 150.0, 35.278339);
        assert_eq!(leftover, 58.14378043006823)
    }

    #[test]
    fn deposit_ratio1() {
        let (token_a_percentage, token_b_percentage) =
            calculate_deposit_ratio(30.3722, 32.831445, 39.7383);
        assert_eq!(token_a_percentage, 70.45478575051277);
        assert_eq!(token_b_percentage, 29.545214249487227);
    }

    #[test]
    fn deposit_ratio2() {
        let (token_a_percentage, token_b_percentage) =
            calculate_deposit_ratio(28.6723, 31.765703, 38.9826);
        assert_eq!(token_a_percentage, 66.08337727877667);
        assert_eq!(token_b_percentage, 33.91662272122334);
    }

    #[test]
    fn deposit_ratio3() {
        let (token_a_percentage, token_b_percentage) =
            calculate_deposit_ratio(30.1785, 31.765703, 51.9926);
        assert_eq!(token_a_percentage, 89.61541280591073);
        assert_eq!(token_b_percentage, 10.384587194089272);
    }

    #[test]
    fn deposit_ratio4() {
        let (token_a_percentage, token_b_percentage) =
            calculate_deposit_ratio(31.1597, 35.278339, 39.7383);
        assert_eq!(token_a_percentage, 48.983524007944307);
        assert_eq!(token_b_percentage, 51.016475992055696);
    }

    #[test]
    fn sqrt_to_f64() {
        let price = sqrt_price_x64_to_price(1844674407370955161, 6, 9);
        assert_eq!(price, 9.999999991044025);
    }

    #[test]
    fn calculate_pool_tokens_first_deposit() {
        let mint_to_amount = calculate_pool_token_mint_to_amount(192600016187, 192600016187, 0);
        assert_eq!(192600016187, mint_to_amount);
    }

    #[test]
    fn calculate_pool_tokens_two_equal_deposits() {
        let mint_to_amount =
            calculate_pool_token_mint_to_amount(192600016187, 192600016187, 192600016187);
        assert_eq!(192600016187, mint_to_amount);
    }

    #[test]
    fn calculate_pool_tokens_two_deposits_second_half_of_first() {
        let mint_to_amount =
            calculate_pool_token_mint_to_amount(98290094549, 196580189098, 196580189098);
        assert_eq!(98290094549, mint_to_amount);
    }

    #[test]
    fn calculate_pool_tokens_three_deposits_first_and_third_equal_second_half_of_first() {
        let mint_to_amount =
            calculate_pool_token_mint_to_amount(196580189098, 294870283647, 294870283647);
        assert_eq!(196580189098, mint_to_amount);
    }

    #[test]
    fn calculate_liquidity_removed() {
        let liquidity_removed = calculate_remove_liquidity_amount(10, 100, 1000);
        assert_eq!(100, liquidity_removed);
    }
}
