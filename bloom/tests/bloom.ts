import * as anchor from "@project-serum/anchor";
import * as splToken from "../node_modules/@solana/spl-token";
import * as sdk from "../sdk/client";
import * as testSdk from "../sdk/testing/client";
const { assert } = require("chai");

describe("bloom", () => {
  // connect to local validator
  const connection = new anchor.web3.Connection(
    "http://localhost:8899",
    "confirmed"
  );

  it("multiple users add and remove", async () => {
    // init users
    const [user1BloomClient, user1TestClient] = await initUserClients(
      connection
    );
    const [user2BloomClient, _user2TestClient] = await initUserClients(
      connection
    );
    const [user3BloomClient, _user3TestClient] = await initUserClients(
      connection
    );

    // create whirlpool vault with mints and mint tokens to declared users
    const poolAddress = await user1TestClient.initTestEnvironment([
      user1BloomClient.provider.wallet.publicKey,
      user2BloomClient.provider.wallet.publicKey,
      user3BloomClient.provider.wallet.publicKey,
    ]);

    // initialize bloom vault
    const vaultManagerAddress = await user1BloomClient.initializeVault(
      poolAddress
    );

    const vaultManagerData = await user1BloomClient.fetchVaultManager(
      vaultManagerAddress
    );

    const tokenADecimals = (
      await splToken.getMint(
        user1BloomClient.provider.connection,
        vaultManagerData.tokenA
      )
    ).decimals;

    const user1Amount = new anchor.BN(123 * 10 ** tokenADecimals);
    const user2Amount = new anchor.BN(10 * 10 ** tokenADecimals);
    const user3Amount = new anchor.BN(39 * 10 ** tokenADecimals);

    await user1BloomClient.addLiquidity(vaultManagerAddress, user1Amount);

    await user2BloomClient.addLiquidity(vaultManagerAddress, user2Amount);

    await user3BloomClient.addLiquidity(vaultManagerAddress, user3Amount);

    // check all users have same amount of pool tokens
    let poolTokenBalances = await getPoolTokenBalances(
      user1BloomClient.provider.connection,
      vaultManagerData.poolToken,
      [
        user1BloomClient.provider.wallet.publicKey,
        user2BloomClient.provider.wallet.publicKey,
        user3BloomClient.provider.wallet.publicKey,
      ]
    );

    assert.ok(
      poolTokenBalances[0].gt(poolTokenBalances[1]) &&
        poolTokenBalances[0].gt(poolTokenBalances[2])
    );
    assert.ok(poolTokenBalances[1].lt(poolTokenBalances[2]));

    await user1BloomClient.removeLiquidity(vaultManagerAddress);

    await user2BloomClient.removeLiquidity(vaultManagerAddress);

    await user3BloomClient.removeLiquidity(vaultManagerAddress);

    // check all users have 0 pool tokens
    let poolTokenBalancesZero = await getPoolTokenBalances(
      user1BloomClient.provider.connection,
      vaultManagerData.poolToken,
      [
        user1BloomClient.provider.wallet.publicKey,
        user2BloomClient.provider.wallet.publicKey,
        user3BloomClient.provider.wallet.publicKey,
      ]
    );

    for (let balance of poolTokenBalancesZero) {
      assert.equal(0, balance.toNumber());
    }

    // should have 0 supply since all users removed liquidity
    const poolTokenMint = await splToken.getMint(
      user1BloomClient.provider.connection,
      vaultManagerData.poolToken,
      "confirmed"
    );
    assert.equal(0, poolTokenMint.supply);
  });

  it("call rebalance when position is in range", async () => {
    const [user1BloomClient, user1TestClient] = await initUserClients(
      connection
    );

    // create whirlpool vault with mints and mint tokens to declared users
    const poolAddress = await user1TestClient.initTestEnvironment([
      user1BloomClient.provider.wallet.publicKey,
    ]);

    // initialize bloom vault
    const vaultManagerAddress = await user1BloomClient.initializeVault(
      poolAddress
    );

    const waitForPositionInRangeEvent =
      user1BloomClient.waitForPositionInRangeEvent();

    // call rebalance immediately
    await user1BloomClient.rebalancePositions(vaultManagerAddress);

    await waitForPositionInRangeEvent;
  });

  it.only("call rebalance when position is out of range", async () => {
    const [user1BloomClient, user1TestClient] = await initUserClients(
      connection
    );

    // create whirlpool vault with mints and mint tokens to declared users
    const poolAddress = await user1TestClient.initTestEnvironment([
      user1BloomClient.provider.wallet.publicKey,
    ]);

    // initialize bloom vault
    const vaultManagerAddress = await user1BloomClient.initializeVault(
      poolAddress
    );

    const vaultManager = await user1BloomClient.fetchVaultManager(
      vaultManagerAddress
    );

    const tokenADecimals = (
      await splToken.getMint(
        user1BloomClient.provider.connection,
        vaultManager.tokenA,
        "confirmed"
      )
    ).decimals;

    await user1BloomClient.addLiquidity(
      vaultManagerAddress,
      new anchor.BN(10 * 10 ** tokenADecimals)
    );

    // swap until position is out of range
    let positionInRange = await user1BloomClient.isPositionInRange(
      vaultManagerAddress
    );
    while (positionInRange) {
      await user1TestClient.swapAtoB(vaultManagerAddress, 5);
      positionInRange = await user1BloomClient.isPositionInRange(
        vaultManagerAddress
      );
    }

    await user1BloomClient.rebalancePositions(vaultManagerAddress);
  });
});

async function initUserClients(
  connection: anchor.web3.Connection
): Promise<[sdk.Client, testSdk.Client]> {
  const user = anchor.web3.Keypair.generate();
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(user),
    { commitment: "confirmed" }
  );

  const bloomClient = new sdk.Client(provider);
  const testClient = new testSdk.Client(provider);

  return [bloomClient, testClient];
}

async function getPoolTokenBalances(
  connection: anchor.web3.Connection,
  poolTokenMint: anchor.web3.PublicKey,
  users: anchor.web3.PublicKey[]
): Promise<anchor.BN[]> {
  let amounts: anchor.BN[] = [];
  for (let user of users) {
    const userAta = await splToken.getAssociatedTokenAddress(
      poolTokenMint,
      user
    );
    const result = await connection.getTokenAccountBalance(
      userAta,
      "confirmed"
    );

    amounts.push(new anchor.BN(result.value.amount));
  }

  return amounts;
}
