use anchor_lang::error_code;

#[error_code]
pub enum BloomErrorCode {
    #[msg("Position Out Of Range")]
    PositionOutOfRange,

    #[msg("Invalid Pool Token Mint")]
    InvalidPoolTokenMint,

    #[msg("Miscalculation")]
    Miscalculation,
}
