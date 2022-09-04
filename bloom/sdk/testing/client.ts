import * as anchor from "@project-serum/anchor";
import * as splToken from "../node_modules/@solana/spl-token";
import * as whirlpool from "@orca-so/whirlpools-sdk";
import { DecimalUtil, Percentage } from "@orca-so/common-sdk";
import { Decimal } from "decimal.js";
import { Bloom, IDL as BloomIDL } from "../../target/types/bloom";
const IDL = require("../../target/idl/bloom.json");

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

  public async initTestEnvironment(
    mintToAddresses: anchor.web3.PublicKey[]
  ): Promise<anchor.web3.PublicKey> {
    // authority on whirlpool and mints
    const payer = await newUser(this.program.provider.connection);

    // create whirlpool and mints
    const wpAccounts = await this.initWhirlpool(
      this.program.provider.connection,
      payer
    );

    const tokenADecimals = (
      await splToken.getMint(this.provider.connection, wpAccounts.tokenAMint)
    ).decimals;
    const tokenBDecimals = (
      await splToken.getMint(this.provider.connection, wpAccounts.tokenBMint)
    ).decimals;

    // mint tokens to payer and any accounts passed in
    for (let mintToAddr of mintToAddresses) {
      const A = await splToken.getAssociatedTokenAddress(
        wpAccounts.tokenAMint,
        mintToAddr
      );
      const AAtaIx = await splToken.createAssociatedTokenAccountInstruction(
        payer.publicKey,
        A,
        mintToAddr,
        wpAccounts.tokenAMint
      );

      const B = await splToken.getAssociatedTokenAddress(
        wpAccounts.tokenBMint,
        mintToAddr
      );
      const BAtaIx = await splToken.createAssociatedTokenAccountInstruction(
        payer.publicKey,
        B,
        mintToAddr,
        wpAccounts.tokenBMint
      );

      const mintAToIx = splToken.createMintToInstruction(
        wpAccounts.tokenAMint,
        A,
        payer.publicKey,
        100_000_000 * 10 ** tokenADecimals
      );
      const mintBToIx = splToken.createMintToInstruction(
        wpAccounts.tokenBMint,
        B,
        payer.publicKey,
        100_000_000 * 10 ** tokenBDecimals
      );

      const txSig = await this.provider.connection.requestAirdrop(
        mintToAddr,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await this.provider.connection.confirmTransaction(txSig);

      const tx = new anchor.web3.Transaction().add(
        AAtaIx,
        BAtaIx,
        mintAToIx,
        mintBToIx
      );
      await this.provider.sendAndConfirm(tx, [payer]);
    }

    return wpAccounts.pool;
  }

  public async initWhirlpool(
    connection: anchor.web3.Connection,
    payer: anchor.web3.Keypair
  ): Promise<WhirlpoolAccounts> {
    const wpCtx = whirlpool.WhirlpoolContext.from(
      connection,
      new anchor.Wallet(payer),
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID
    );

    const whirlpoolConfig = anchor.web3.Keypair.generate();

    const initializeConfigTxSig = await wpCtx.program.methods
      .initializeConfig(payer.publicKey, payer.publicKey, payer.publicKey, 2000)
      .accounts({
        config: whirlpoolConfig.publicKey,
        funder: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([whirlpoolConfig])
      .rpc();
    console.log("initializeConfigTxSig: %s", initializeConfigTxSig);

    const feeTierPda = whirlpool.PDAUtil.getFeeTier(
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      whirlpoolConfig.publicKey,
      64
    );

    const initializeFeeTierTxSig = await wpCtx.program.methods
      .initializeFeeTier(64, 100)
      .accounts({
        config: whirlpoolConfig.publicKey,
        feeTier: feeTierPda.publicKey,
        funder: payer.publicKey,
        feeAuthority: payer.publicKey,
      })
      .rpc();
    console.log("initializeFeeTierTx: %s", initializeFeeTierTxSig);

    const token1Mint = await splToken.createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      9
    );
    const token2Mint = await splToken.createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      6
    );

    let [tokenAMint, tokenBMint] = whirlpool.PoolUtil.orderMints(
      token1Mint,
      token2Mint
    );
    tokenAMint = new anchor.web3.PublicKey(tokenAMint);
    tokenBMint = new anchor.web3.PublicKey(tokenBMint);

    const tokenADecimals = (await splToken.getMint(connection, tokenAMint))
      .decimals;
    const tokenBDecimals = (await splToken.getMint(connection, tokenBMint))
      .decimals;

    const tokenAVault = anchor.web3.Keypair.generate();
    const tokenBVault = anchor.web3.Keypair.generate();

    const whirlpoolPda = whirlpool.PDAUtil.getWhirlpool(
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
      whirlpoolConfig.publicKey,
      tokenAMint,
      tokenBMint,
      64
    );

    const bumps: whirlpool.WhirlpoolBumpsData = {
      whirlpoolBump: whirlpoolPda.bump,
    };

    const initSqrtPrice = whirlpool.PriceMath.priceToSqrtPriceX64(
      new Decimal(10),
      tokenADecimals,
      tokenBDecimals
    );

    const initializePoolTxSig = await wpCtx.program.methods
      .initializePool(bumps, 64, new anchor.BN(initSqrtPrice))
      .accounts({
        whirlpool: whirlpoolPda.publicKey,
        whirlpoolsConfig: whirlpoolConfig.publicKey,
        tokenMintA: tokenAMint,
        tokenMintB: tokenBMint,
        funder: payer.publicKey,
        tokenVaultA: tokenAVault.publicKey,
        tokenVaultB: tokenBVault.publicKey,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
        feeTier: feeTierPda.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([tokenAVault, tokenBVault])
      .rpc();
    console.log("initializePoolTxSig: %s", initializePoolTxSig);

    await delayMs(1000);

    // init a bunch of tick arrays
    await this.initTickArrays(wpCtx, whirlpoolPda.publicKey, payer);

    // create ATA's for payer and mint initial tokens
    const payerATa = await splToken.getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      tokenAMint,
      payer.publicKey
    );
    const payerBTa = await splToken.getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      tokenBMint,
      payer.publicKey
    );

    const mintAToPayerTxSig = await splToken.mintTo(
      connection,
      payer,
      tokenAMint,
      payerATa.address,
      payer.publicKey,
      100_000_000 * 10 ** tokenADecimals
    );
    console.log("mintAToPayerTxSig: %s", mintAToPayerTxSig);

    const mintBToPayerTxSig = await splToken.mintTo(
      connection,
      payer,
      tokenBMint,
      payerBTa.address,
      payer.publicKey,
      100_000_000 * 10 ** tokenBDecimals
    );
    console.log("mintBToPayerTxSig: %s", mintBToPayerTxSig);

    // add liquidity to pool
    await this.addLiquidity(
      wpCtx,
      whirlpoolPda.publicKey,
      tokenAMint,
      tokenBMint,
      10
    );

    return {
      tokenAMint: tokenAMint,
      tokenBMint: tokenBMint,
      tokenAVault: tokenAVault.publicKey,
      tokenBVault: tokenBVault.publicKey,
      feeTier: feeTierPda.publicKey,
      config: whirlpoolConfig.publicKey,
      pool: whirlpoolPda.publicKey,
      authority: payer,
    };
  }

  public async addLiquidity(
    wpCtx: whirlpool.WhirlpoolContext,
    poolAddr: anchor.web3.PublicKey,
    tokenAMint: anchor.web3.PublicKey,
    tokenBMint: anchor.web3.PublicKey,
    count: number
  ) {
    const wpClient = whirlpool.buildWhirlpoolClient(wpCtx);

    const pool = await wpClient.getPool(poolAddr, true);

    const tokenMintADecimals = (
      await splToken.getMint(wpCtx.connection, tokenAMint)
    ).decimals;
    const tokenMintBDecimals = (
      await splToken.getMint(wpCtx.connection, tokenBMint)
    ).decimals;

    let openPositionPromises = [];
    for (let i = 0; i < count; i++) {
      // get 2 random prices to provide liquidity at
      let randomPrice1 = Math.floor(Math.random() * 100) + 1;
      let randomPrice2 = Math.floor(Math.random() * 100) + 1;

      let lowerPrice: number;
      let upperPrice: number;
      if (randomPrice1 > randomPrice2) {
        lowerPrice = randomPrice2;
        upperPrice = randomPrice1;
      } else if (randomPrice1 === randomPrice2) {
        lowerPrice = randomPrice1 - 1;
        upperPrice = randomPrice2;
      } else {
        lowerPrice = randomPrice1;
        upperPrice = randomPrice2;
      }

      const tickLowerIndex = whirlpool.PriceMath.priceToInitializableTickIndex(
        new Decimal(lowerPrice),
        tokenMintADecimals,
        tokenMintBDecimals,
        pool.getData().tickSpacing
      );
      const tickUpperIndex = whirlpool.PriceMath.priceToInitializableTickIndex(
        new Decimal(upperPrice),
        tokenMintADecimals,
        tokenMintBDecimals,
        pool.getData().tickSpacing
      );

      // choose a random amount of input tokens
      const inputTokenAmount = Math.floor(Math.random() * 100000) + 10001;

      const quote = whirlpool.increaseLiquidityQuoteByInputToken(
        tokenAMint,
        new Decimal(inputTokenAmount),
        tickLowerIndex,
        tickUpperIndex,
        Percentage.fromFraction(1, 100),
        pool
      );

      if (quote.liquidityAmount.eq(new anchor.BN(0))) {
        console.log("0 liquidity detected, skipping");
        continue;
      }

      const openPosition = await pool.openPosition(
        tickLowerIndex,
        tickUpperIndex,
        quote
      );

      const openPositionPromise = openPosition.tx.buildAndExecute();
      openPositionPromises.push(openPositionPromise);
    }

    await Promise.all(openPositionPromises);
    console.log("liquidity added");
  }

  public async initTickArrays(
    wpCtx: whirlpool.WhirlpoolContext,
    pool: anchor.web3.PublicKey,
    payer: anchor.web3.Keypair
  ) {
    const poolData = await wpCtx.fetcher.getPool(pool, true);

    const startIndex = whirlpool.TickUtil.getStartTickIndex(
      whirlpool.MIN_TICK_INDEX,
      poolData.tickSpacing
    );

    const tickArrayPda = whirlpool.PDAUtil.getTickArrayFromTickIndex(
      startIndex,
      poolData.tickSpacing,
      pool,
      whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID
    );

    // initialize tick array
    const initializeTickArrayTxSig = await wpCtx.program.methods
      .initializeTickArray(startIndex)
      .accounts({
        funder: payer.publicKey,
        tickArray: tickArrayPda.publicKey,
        whirlpool: pool,
      })
      .rpc({ skipPreflight: true });
    console.log("initializeTickArrayTxSig: %s", initializeTickArrayTxSig);

    const promises: Promise<string>[] = [];
    for (let offset = -49; offset <= 50; offset++) {
      const startIndex = whirlpool.TickUtil.getStartTickIndex(
        poolData.tickCurrentIndex,
        poolData.tickSpacing,
        offset
      );

      const tickArrayPda = whirlpool.PDAUtil.getTickArrayFromTickIndex(
        startIndex,
        poolData.tickSpacing,
        pool,
        whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID
      );

      // initialize tick array
      const initializeTickArray = wpCtx.program.methods
        .initializeTickArray(startIndex)
        .accounts({
          funder: payer.publicKey,
          tickArray: tickArrayPda.publicKey,
          whirlpool: pool,
        })
        .rpc({ skipPreflight: true });

      promises.push(initializeTickArray);
    }

    await Promise.all(promises);

    console.log("tick arrays initialized");
  }

  public async swapBothDirections(
    vaultManagerAddress: anchor.web3.PublicKey,
    count: number
  ) {
    const vaultManager = await this.program.account.vaultManager.fetch(
      vaultManagerAddress
    );

    const otherAmountThreshold = DecimalUtil.toU64(DecimalUtil.fromNumber(0));

    let aToB = true;
    let sqrtPriceLimit = new anchor.BN(whirlpool.MIN_SQRT_PRICE);

    for (let i = 0; i < count; i++) {
      const pool = await this.wpClient.getPool(vaultManager.pool, true);

      let decimals: number;
      if (i % 2 === 0) {
        aToB = true;
        sqrtPriceLimit = new anchor.BN(whirlpool.MIN_SQRT_PRICE);
        decimals = pool.getTokenAInfo().decimals;
      } else {
        aToB = false;
        sqrtPriceLimit = new anchor.BN(whirlpool.MAX_SQRT_PRICE);
        decimals = pool.getTokenBInfo().decimals;
      }

      const tokenAmount = DecimalUtil.toU64(
        DecimalUtil.fromNumber(
          (Math.floor(Math.random() * 1000) + 1) * 10 ** decimals
        )
      );

      const tickArrays = await whirlpool.SwapUtils.getTickArrays(
        pool.getData().tickCurrentIndex,
        pool.getData().tickSpacing,
        aToB,
        whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
        pool.getAddress(),
        this.wpClient.getFetcher(),
        true
      );

      for (let ta of tickArrays) {
        const taData = await this.wpClient
          .getFetcher()
          .getTickArray(ta.address, true);
        if (!taData.ticks) {
          console.log("tickArray not initialized");
        }
      }

      const swapParams: whirlpool.SwapQuoteParam = {
        whirlpoolData: pool.getData(),
        tokenAmount: tokenAmount,
        otherAmountThreshold: otherAmountThreshold,
        sqrtPriceLimit: sqrtPriceLimit,
        aToB: aToB,
        amountSpecifiedIsInput: true,
        tickArrays: tickArrays,
      };
      const swapQuote = whirlpool.swapQuoteWithParams(
        swapParams,
        Percentage.fromFraction(10, 100)
      );
      const tx = await pool.swap(swapQuote, this.provider.wallet.publicKey);
      try {
        const swapTxSig = await tx.buildAndExecute();

        const updatedPool = await this.wpClient.getPool(
          vaultManager.pool,
          true
        );

        const currentPrice = whirlpool.PriceMath.tickIndexToPrice(
          updatedPool.getData().tickCurrentIndex,
          updatedPool.getTokenAInfo().decimals,
          updatedPool.getTokenBInfo().decimals
        );
        console.log(
          "current price: %d, swapTxSig: %s",
          currentPrice.toNumber(),
          swapTxSig
        );
      } catch (e) {
        console.log(e);
      }
    }
  }

  public async swapAtoB(
    vaultManagerAddress: anchor.web3.PublicKey,
    count: number
  ) {
    const vaultManager = await this.program.account.vaultManager.fetch(
      vaultManagerAddress
    );

    const otherAmountThreshold = DecimalUtil.toU64(DecimalUtil.fromNumber(0));

    let aToB = true;
    let sqrtPriceLimit = new anchor.BN(whirlpool.MIN_SQRT_PRICE);

    for (let i = 0; i < count; i++) {
      const pool = await this.wpClient.getPool(vaultManager.pool, true);

      let decimals: number;
      aToB = true;
      sqrtPriceLimit = new anchor.BN(whirlpool.MIN_SQRT_PRICE);
      decimals = pool.getTokenAInfo().decimals;

      const tokenAmount = DecimalUtil.toU64(
        DecimalUtil.fromNumber(
          (Math.floor(Math.random() * 3000) + 1) * 10 ** decimals
        )
      );

      const tickArrays = await whirlpool.SwapUtils.getTickArrays(
        pool.getData().tickCurrentIndex,
        pool.getData().tickSpacing,
        aToB,
        whirlpool.ORCA_WHIRLPOOL_PROGRAM_ID,
        pool.getAddress(),
        this.wpClient.getFetcher(),
        true
      );

      for (let ta of tickArrays) {
        const taData = await this.wpClient
          .getFetcher()
          .getTickArray(ta.address, true);
        if (!taData.ticks) {
          console.log("tickArray not initialized");
        }
      }

      const swapParams: whirlpool.SwapQuoteParam = {
        whirlpoolData: pool.getData(),
        tokenAmount: tokenAmount,
        otherAmountThreshold: otherAmountThreshold,
        sqrtPriceLimit: sqrtPriceLimit,
        aToB: aToB,
        amountSpecifiedIsInput: true,
        tickArrays: tickArrays,
      };
      try {
        const swapQuote = whirlpool.swapQuoteWithParams(
          swapParams,
          Percentage.fromFraction(1, 100)
        );
        const tx = await pool.swap(swapQuote, this.provider.wallet.publicKey);

        const swapTxSig = await tx.buildAndExecute();

        const updatedPool = await this.wpClient.getPool(
          vaultManager.pool,
          true
        );

        const currentPrice = whirlpool.PriceMath.tickIndexToPrice(
          updatedPool.getData().tickCurrentIndex,
          updatedPool.getTokenAInfo().decimals,
          updatedPool.getTokenBInfo().decimals
        );
        console.log(
          "current price: %d, swapTxSig: %s",
          currentPrice.toNumber(),
          swapTxSig
        );
      } catch (e) {
        console.log(e);
      }
    }
  }
}

interface WhirlpoolAccounts {
  tokenAMint: anchor.web3.PublicKey;
  tokenBMint: anchor.web3.PublicKey;
  tokenAVault: anchor.web3.PublicKey;
  tokenBVault: anchor.web3.PublicKey;
  pool: anchor.web3.PublicKey;
  config: anchor.web3.PublicKey;
  authority: anchor.web3.Keypair;
  feeTier: anchor.web3.PublicKey;
}

function delayMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function newUser(
  connection: anchor.web3.Connection
): Promise<anchor.web3.Keypair> {
  const user = anchor.web3.Keypair.generate();

  const txSig = await connection.requestAirdrop(
    user.publicKey,
    10 * anchor.web3.LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(txSig);
  return user;
}
