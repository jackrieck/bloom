import * as anchor from "@project-serum/anchor";
import * as splToken from "./node_modules/@solana/spl-token";
import * as whirlpool from "@orca-so/whirlpools-sdk";
import { Bloom, IDL as BloomIDL } from "../target/types/bloom";
import Decimal from "decimal.js";
const IDL = require("../target/idl/bloom.json");

export class Client {
  readonly provider: anchor.AnchorProvider;
  private program: anchor.Program<Bloom>;
  private wpClient: whirlpool.WhirlpoolClient;

  constructor(provider: anchor.AnchorProvider) {
    const program: anchor.Program<Bloom> = new anchor.Program(
      BloomIDL,
      IDL.metadata.address,
      provider
    );

    const wpCtx = whirlpool.WhirlpoolContext.from(
      provider.connection,
      provider.wallet,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID
    );

    const wpClient = whirlpool.buildWhirlpoolClient(wpCtx);

    this.provider = provider;
    this.program = program;
    this.wpClient = wpClient;
  }

  public async fetchVaultManager(
    vaultManagerAddress: anchor.web3.PublicKey
  ): Promise<VaultData> {
    const vaultManagerData = await this.program.account.vaultManager.fetch(
      vaultManagerAddress
    );

    return {
      tokenA: vaultManagerData.tokenA,
      tokenB: vaultManagerData.tokenB,
      poolToken: vaultManagerData.poolToken,
      tokenAVault: vaultManagerData.tokenAVault,
      tokenBVault: vaultManagerData.tokenBVault,
      pool: vaultManagerData.pool,
      tokenAPoolVault: vaultManagerData.tokenAPoolVault,
      tokenBPoolVault: vaultManagerData.tokenBPoolVault,
      poolPosition: vaultManagerData.poolPosition,
      poolPositionMint: vaultManagerData.poolPositionMint,
      poolPositionMintSeed: vaultManagerData.poolPositionMintSeed,
      poolPositionTokenAccount: vaultManagerData.poolPositionTokenAccount,
      admin: vaultManagerData.admin,
    };
  }

  public async fetchPool(
    pool: anchor.web3.PublicKey
  ): Promise<whirlpool.WhirlpoolData> {
    return await this.wpClient.getFetcher().getPool(pool, true);
  }

  public async initializeVault(
    poolAddress: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> {
    const pool = await this.fetchPool(poolAddress);

    // create vault PDAs
    const [vaultManager, _vaultBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [poolAddress.toBuffer()],
        this.program.programId
      );

    const [tokenAVault, _tokenAVaultBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [vaultManager.toBuffer(), pool.tokenMintA.toBuffer()],
        this.program.programId
      );

    const [tokenBVault, _tokenBVaultBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [vaultManager.toBuffer(), pool.tokenMintB.toBuffer()],
        this.program.programId
      );

    const [poolToken, _poolTokenBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("pool_token"), vaultManager.toBuffer()],
        this.program.programId
      );

    const tokenADecimals = (
      await splToken.getMint(
        this.provider.connection,
        pool.tokenMintA,
        "confirmed"
      )
    ).decimals;
    const tokenBDecimals = (
      await splToken.getMint(
        this.provider.connection,
        pool.tokenMintB,
        "confirmed"
      )
    ).decimals;

    const currentPrice = whirlpool.PriceMath.tickIndexToPrice(
      pool.tickCurrentIndex,
      tokenADecimals,
      tokenBDecimals
    );
    const lowerPrice = currentPrice.mul(new Decimal(0.95));
    const upperPrice = currentPrice.mul(new Decimal(1.05));

    const lowerTickIndex = whirlpool.PriceMath.priceToInitializableTickIndex(
      lowerPrice,
      tokenADecimals,
      tokenBDecimals,
      pool.tickSpacing
    );
    const upperTickIndex = whirlpool.PriceMath.priceToInitializableTickIndex(
      upperPrice,
      tokenADecimals,
      tokenBDecimals,
      pool.tickSpacing
    );

    const initializableLowerPrice = whirlpool.PriceMath.tickIndexToPrice(
      lowerTickIndex,
      tokenADecimals,
      tokenBDecimals
    );
    const initializableUpperPrice = whirlpool.PriceMath.tickIndexToPrice(
      upperTickIndex,
      tokenADecimals,
      tokenBDecimals
    );

    console.log(
      "currentPrice: %d, sqrtPrice: %s, lowerPrice: %d, upperPrice: %d, tokenADecimals: %d, tokenBDecimals: %d",
      currentPrice.toNumber(),
      pool.sqrtPrice.toString(),
      initializableLowerPrice,
      initializableUpperPrice,
      tokenADecimals,
      tokenBDecimals
    );

    // pool position PDAs
    const poolPositionMintSeed = "dkfjgl";
    const [poolPositionMint, _poolPositionMintBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("pool_position_mint"),
          Buffer.from(poolPositionMintSeed),
          poolAddress.toBuffer(),
        ],
        this.program.programId
      );
    const poolPositionPda = whirlpool.PDAUtil.getPosition(
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      poolPositionMint
    );
    const poolPositionTokenAccount = await splToken.getAssociatedTokenAddress(
      poolPositionMint,
      vaultManager,
      true
    );

    // initialize new vault
    const initializeVaultTxSig = await this.program.methods
      .initializeVault(poolPositionMintSeed, lowerTickIndex, upperTickIndex)
      .accounts({
        vaultManager: vaultManager,
        tokenA: pool.tokenMintA,
        tokenB: pool.tokenMintB,
        poolToken: poolToken,
        tokenAVault: tokenAVault,
        tokenBVault: tokenBVault,
        pool: poolAddress,
        poolPosition: poolPositionPda.publicKey,
        poolPositionMint: poolPositionMint,
        poolPositionTokenAccount: poolPositionTokenAccount,
        tokenAPoolVault: pool.tokenVaultA,
        tokenBPoolVault: pool.tokenVaultB,
        admin: this.provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
        whirlpoolProgram: whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true });
    console.log("initializeVaultTxSig: %s", initializeVaultTxSig);

    return vaultManager;
  }

  public async rebalancePositions(vaultManagerAddress: anchor.web3.PublicKey) {
    const vaultManagerData = await this.fetchVaultManager(vaultManagerAddress);

    const newPoolPositionMintSeed = "lakdls";
    const [newPoolPositionMint, _poolPositionMintBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("pool_position_mint"),
          Buffer.from(newPoolPositionMintSeed),
          vaultManagerData.pool.toBuffer(),
        ],
        this.program.programId
      );
    const newPoolPositionPda = whirlpool.PDAUtil.getPosition(
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      newPoolPositionMint
    );
    const newPoolPositionTokenAccount =
      await splToken.getAssociatedTokenAddress(
        newPoolPositionMint,
        vaultManagerAddress,
        true
      );

    // get whirlpool data to get current tick
    const poolData = await this.fetchPool(vaultManagerData.pool);

    const tokenADecimals = (
      await splToken.getMint(
        this.provider.connection,
        poolData.tokenMintA,
        "confirmed"
      )
    ).decimals;
    const tokenBDecimals = (
      await splToken.getMint(
        this.provider.connection,
        poolData.tokenMintB,
        "confirmed"
      )
    ).decimals;

    const currentPrice = whirlpool.PriceMath.sqrtPriceX64ToPrice(
      poolData.sqrtPrice,
      tokenADecimals,
      tokenBDecimals
    );
    const lowerPrice = currentPrice.mul(new Decimal(0.95));
    const upperPrice = currentPrice.mul(new Decimal(1.05));
    //console.log("lowerPrice: %s, currentPrice: %d, upperPrice: %d", lowerPrice.toNumber(), currentPrice.toNumber(), upperPrice.toNumber());

    const lowerTickIndex = whirlpool.PriceMath.priceToInitializableTickIndex(
      lowerPrice,
      tokenADecimals,
      tokenBDecimals,
      poolData.tickSpacing
    );

    const currentTickIndex = whirlpool.TickUtil.getInitializableTickIndex(
      poolData.tickCurrentIndex,
      poolData.tickSpacing
    );

    const upperTickIndex = whirlpool.PriceMath.priceToInitializableTickIndex(
      upperPrice,
      tokenADecimals,
      tokenBDecimals,
      poolData.tickSpacing
    );

    const lowerTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      lowerTickIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );

    const currentTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      currentTickIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );

    const upperTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      upperTickIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );

    // get old ticks for decreasing liquidity
    const oldPosition = await this.wpClient.getPosition(
      vaultManagerData.poolPosition,
      true
    );

    const oldLowerTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      oldPosition.getData().tickLowerIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );

    const oldUpperTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      oldPosition.getData().tickUpperIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );

    const oraclePda = whirlpool.PDAUtil.getOracle(
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool
    );

    const increaseComputeBudgetIx =
      anchor.web3.ComputeBudgetProgram.requestUnits({
        units: 1_400_000, // MAX
        additionalFee: 5000,
      });

    const rebalanceOpenPositionTxSig = await this.program.methods
      .rebalancePositions(
        newPoolPositionMintSeed,
        lowerTickIndex,
        upperTickIndex
      )
      .accounts({
        vaultManager: vaultManagerAddress,
        tokenA: vaultManagerData.tokenA,
        tokenB: vaultManagerData.tokenB,
        tokenAVault: vaultManagerData.tokenAVault,
        tokenBVault: vaultManagerData.tokenBVault,
        pool: vaultManagerData.pool,
        tokenAPoolVault: poolData.tokenVaultA,
        tokenBPoolVault: poolData.tokenVaultB,
        oldPoolPosition: vaultManagerData.poolPosition,
        oldPoolPositionMint: vaultManagerData.poolPositionMint,
        oldPoolPositionTokenAccount: vaultManagerData.poolPositionTokenAccount,
        oldTickArrayLower: oldLowerTickIndexPda[0].publicKey,
        oldTickArrayUpper: oldUpperTickIndexPda[0].publicKey,
        newTickArrayLower: lowerTickIndexPda[0].publicKey,
        tickArrayCurrent: currentTickIndexPda[0].publicKey,
        newTickArrayUpper: upperTickIndexPda[0].publicKey,
        oracle: oraclePda.publicKey,
        newPoolPosition: newPoolPositionPda.publicKey,
        newPoolPositionMint: newPoolPositionMint,
        newPoolPositionTokenAccount: newPoolPositionTokenAccount,
        crank: this.provider.wallet.publicKey,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
        whirlpoolProgram: whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .preInstructions([increaseComputeBudgetIx])
      .rpc({ skipPreflight: true });
    console.log("rebalanceOpenPositionTxSig: %s", rebalanceOpenPositionTxSig);
  }

  public async addLiquidity(
    vaultManagerAddress: anchor.web3.PublicKey,
    tokenAAmountIn: anchor.BN
  ) {
    const vaultManagerData = await this.fetchVaultManager(vaultManagerAddress);

    const [poolPositionMint, _poolPositionMintBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("pool_position_mint"),
          Buffer.from(vaultManagerData.poolPositionMintSeed),
          vaultManagerData.pool.toBuffer(),
        ],
        this.program.programId
      );
    const poolPositionPda = whirlpool.PDAUtil.getPosition(
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      poolPositionMint
    );
    const poolPositionTokenAccount = await splToken.getAssociatedTokenAddress(
      poolPositionMint,
      vaultManagerAddress,
      true
    );

    // get whirlpool data to get current tick
    const poolData = await this.fetchPool(vaultManagerData.pool);

    // derive lower and upper ticks from current tick
    const lowerTickIndex = whirlpool.TickUtil.getPrevInitializableTickIndex(
      poolData.tickCurrentIndex,
      poolData.tickSpacing
    );
    const upperTickIndex = whirlpool.TickUtil.getNextInitializableTickIndex(
      poolData.tickCurrentIndex,
      poolData.tickSpacing
    );

    const lowerTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      lowerTickIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );
    const upperTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      upperTickIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );

    const userTokenAAta = await splToken.getAssociatedTokenAddress(
      vaultManagerData.tokenA,
      this.provider.wallet.publicKey
    );
    const userTokenBAta = await splToken.getAssociatedTokenAddress(
      vaultManagerData.tokenB,
      this.provider.wallet.publicKey
    );

    const userPoolTokenAta = await splToken.getAssociatedTokenAddress(
      vaultManagerData.poolToken,
      this.provider.wallet.publicKey
    );

    const addLiquidityTxSig = await this.program.methods
      .addLiquidity(tokenAAmountIn)
      .accounts({
        vaultManager: vaultManagerAddress,
        tokenA: vaultManagerData.tokenA,
        tokenB: vaultManagerData.tokenB,
        poolToken: vaultManagerData.poolToken,
        pool: vaultManagerData.pool,
        tokenAPoolVault: poolData.tokenVaultA,
        tokenBPoolVault: poolData.tokenVaultB,
        poolPosition: poolPositionPda.publicKey,
        poolPositionMint: poolPositionMint,
        poolPositionTokenAccount: poolPositionTokenAccount,
        tickArrayLower: lowerTickIndexPda[0].publicKey,
        tickArrayUpper: upperTickIndexPda[0].publicKey,
        user: this.provider.wallet.publicKey,
        userTokenAAta: userTokenAAta,
        userTokenBAta: userTokenBAta,
        userPoolTokenAta: userPoolTokenAta,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
        whirlpoolProgram: whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: false });
    console.log("addLiquidityTxSig: %s", addLiquidityTxSig);
  }

  public async removeLiquidity(vaultManagerAddress: anchor.web3.PublicKey) {
    const vaultManagerData = await this.fetchVaultManager(vaultManagerAddress);

    const [poolPositionMint, _poolPositionMintBump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("pool_position_mint"),
          Buffer.from(vaultManagerData.poolPositionMintSeed),
          vaultManagerData.pool.toBuffer(),
        ],
        this.program.programId
      );
    const poolPositionPda = whirlpool.PDAUtil.getPosition(
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      poolPositionMint
    );
    const poolPositionTokenAccount = await splToken.getAssociatedTokenAddress(
      poolPositionMint,
      vaultManagerAddress,
      true
    );

    // get whirlpool data to get current tick
    const poolData = await this.fetchPool(vaultManagerData.pool);

    // derive lower and upper ticks from current tick
    const lowerTickIndex = whirlpool.TickUtil.getPrevInitializableTickIndex(
      poolData.tickCurrentIndex,
      poolData.tickSpacing
    );
    const upperTickIndex = whirlpool.TickUtil.getNextInitializableTickIndex(
      poolData.tickCurrentIndex,
      poolData.tickSpacing
    );

    const lowerTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      lowerTickIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );
    const upperTickIndexPda = await whirlpool.TickArrayUtil.getTickArrayPDAs(
      upperTickIndex,
      poolData.tickSpacing,
      1,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      vaultManagerData.pool,
      true
    );

    const userTokenAAta = await splToken.getAssociatedTokenAddress(
      vaultManagerData.tokenA,
      this.provider.wallet.publicKey
    );
    const userTokenBAta = await splToken.getAssociatedTokenAddress(
      vaultManagerData.tokenB,
      this.provider.wallet.publicKey
    );
    const userPoolTokenAta = await splToken.getAssociatedTokenAddress(
      vaultManagerData.poolToken,
      this.provider.wallet.publicKey
    );

    const removeLiquidityTxSig = await this.program.methods
      .removeLiquidity()
      .accounts({
        vaultManager: vaultManagerAddress,
        tokenA: vaultManagerData.tokenA,
        tokenB: vaultManagerData.tokenB,
        pool: vaultManagerData.pool,
        poolToken: vaultManagerData.poolToken,
        tokenAPoolVault: poolData.tokenVaultA,
        tokenBPoolVault: poolData.tokenVaultB,
        poolPosition: poolPositionPda.publicKey,
        poolPositionMint: poolPositionMint,
        poolPositionTokenAccount: poolPositionTokenAccount,
        tickArrayLower: lowerTickIndexPda[0].publicKey,
        tickArrayUpper: upperTickIndexPda[0].publicKey,
        user: this.provider.wallet.publicKey,
        userTokenAAta: userTokenAAta,
        userTokenBAta: userTokenBAta,
        userPoolTokenAta: userPoolTokenAta,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
        whirlpoolProgram: whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true });
    console.log("removeLiquidityTxSig: %s", removeLiquidityTxSig);
  }

  public async isPositionInRange(
    vaultManagerAddress: anchor.web3.PublicKey
  ): Promise<boolean> {
    const vaultManagerData = await this.fetchVaultManager(vaultManagerAddress);

    const position = (
      await this.wpClient.getPosition(vaultManagerData.poolPosition, true)
    ).getData();
    const pool = (
      await this.wpClient.getPool(vaultManagerData.pool, true)
    ).getData();

    const tokenADecimals = (
      await splToken.getMint(this.provider.connection, vaultManagerData.tokenA)
    ).decimals;
    const tokenBDecimals = (
      await splToken.getMint(this.provider.connection, vaultManagerData.tokenB)
    ).decimals;

    const currentPrice = whirlpool.PriceMath.sqrtPriceX64ToPrice(
      pool.sqrtPrice,
      tokenADecimals,
      tokenBDecimals
    );

    const lowerPrice = whirlpool.PriceMath.tickIndexToPrice(
      position.tickLowerIndex,
      tokenADecimals,
      tokenBDecimals
    );
    const upperPrice = whirlpool.PriceMath.tickIndexToPrice(
      position.tickUpperIndex,
      tokenADecimals,
      tokenBDecimals
    );

    if (
      currentPrice.lessThan(lowerPrice) ||
      currentPrice.greaterThanOrEqualTo(upperPrice)
    ) {
      return false;
    }

    return true;
  }

  public async waitForPositionInRangeEvent() {
    let listener = null;

    await new Promise((resolve, _reject) => {
      listener = this.program.addEventListener(
        "PositionInRange",
        (event, slot) => {
          resolve([event, slot]);
        }
      );
    });

    await this.program.removeEventListener(listener);
  }
}

export interface VaultData {
  tokenA: anchor.web3.PublicKey;
  tokenB: anchor.web3.PublicKey;
  poolToken: anchor.web3.PublicKey;
  tokenAVault: anchor.web3.PublicKey;
  tokenBVault: anchor.web3.PublicKey;
  pool: anchor.web3.PublicKey;
  tokenAPoolVault: anchor.web3.PublicKey;
  tokenBPoolVault: anchor.web3.PublicKey;
  poolPosition: anchor.web3.PublicKey | null;
  poolPositionMint: anchor.web3.PublicKey | null;
  poolPositionMintSeed: string | null;
  poolPositionTokenAccount: anchor.web3.PublicKey | null;
  admin: anchor.web3.PublicKey;
}
