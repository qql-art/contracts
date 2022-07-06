const { expect } = require("chai");

describe("Shardwallet", () => {
  let Shardwallet;
  let TestERC20;

  const ETH = ethers.constants.AddressZero;

  before(async () => {
    Shardwallet = await ethers.getContractFactory("Shardwallet");
    TestERC20 = await ethers.getContractFactory("TestERC20");
  });

  describe("basic operations", () => {
    it("permits claiming ETH and ERC-20s with a single shard", async () => {
      const [alice] = await ethers.getSigners();
      const bob = ethers.Wallet.createRandom().connect(alice.provider);
      const sw = await Shardwallet.deploy();
      const erc20 = await TestERC20.deploy();

      await expect(sw.deployTransaction)
        .to.emit(sw, "Transfer")
        .withArgs(ethers.constants.AddressZero, alice.address, 1);

      await alice.sendTransaction({ to: sw.address, value: 100 });
      await erc20.mint(sw.address, 500);

      // Deposit some ETH and ERC-20s, then claim.
      const claim1 = sw.claimTo(1, [ETH, erc20.address], bob.address);
      await claim1;
      await expect(claim1).to.emit(sw, "Claim").withArgs(1, ETH, 100);
      await expect(claim1).to.emit(sw, "Claim").withArgs(1, erc20.address, 500);
      expect(await bob.getBalance()).to.equal(100);
      expect(await erc20.balanceOf(bob.address)).to.equal(500);

      // Claim with no new funds.
      const claim2 = sw.claimTo(1, [ETH, erc20.address], bob.address);
      await claim2;
      await expect(claim2).to.emit(sw, "Claim").withArgs(1, ETH, 0);
      await expect(claim2).to.emit(sw, "Claim").withArgs(1, erc20.address, 0);

      // Deposit more funds, then claim again.
      await alice.sendTransaction({ to: sw.address, value: 50 });
      await erc20.mint(sw.address, 250);
      const claim3 = sw.claimTo(1, [ETH, erc20.address], bob.address);
      await claim3;
      await expect(claim3).to.emit(sw, "Claim").withArgs(1, ETH, 50);
      await expect(claim3).to.emit(sw, "Claim").withArgs(1, erc20.address, 250);
      expect(await bob.getBalance()).to.equal(150);
      expect(await erc20.balanceOf(bob.address)).to.equal(750);
    });

    it("permits splitting and claiming from child shards", async () => {
      const [alice] = await ethers.getSigners();
      const bob = ethers.Wallet.createRandom().connect(alice.provider);
      const sw = await Shardwallet.deploy();

      await alice.sendTransaction({ to: sw.address, value: 1000 });
      await sw.claimTo(1, [ETH], bob.address);
      expect(await bob.getBalance()).to.equal(1000);

      const split = await sw.split(1, [
        { shareMicros: 500000, recipient: alice.address },
        { shareMicros: 300000, recipient: alice.address },
        { shareMicros: 200000, recipient: alice.address },
      ]);
      await expect(split)
        .to.emit(sw, "Reforging")
        .withArgs([1], 2, [500000, 300000, 200000]);

      expect(await sw.callStatic.computeClaimed(2, ETH)).to.equal(500);
      expect(await sw.callStatic.computeClaimed(3, ETH)).to.equal(300);
      expect(await sw.callStatic.computeClaimed(4, ETH)).to.equal(200);

      // Claim from two of the three new shards.
      await alice.sendTransaction({ to: sw.address, value: 100 });
      await expect(sw.claimTo(2, [ETH], bob.address))
        .to.emit(sw, "Claim")
        .withArgs(2, ETH, 50);
      expect(await bob.getBalance()).to.equal(1050);
      await expect(sw.claimTo(3, [ETH], bob.address))
        .to.emit(sw, "Claim")
        .withArgs(3, ETH, 30);
      expect(await bob.getBalance()).to.equal(1080);
      expect(await sw.callStatic.computeClaimed(2, ETH)).to.equal(550);
      expect(await sw.callStatic.computeClaimed(3, ETH)).to.equal(330);
      expect(await sw.callStatic.computeClaimed(4, ETH)).to.equal(200);

      const merge = await sw.merge([2, 3, 4]);
      await expect(merge)
        .to.emit(sw, "Reforging")
        .withArgs([2, 3, 4], 5, [1000000]);
      expect(await sw.callStatic.computeClaimed(5, ETH)).to.equal(1080);

      // Claim the 20 wei left over from shard 4, plus 10 new wei.
      await alice.sendTransaction({ to: sw.address, value: 10 });
      await expect(sw.claimTo(5, [ETH], bob.address))
        .to.emit(sw, "Claim")
        .withArgs(5, ETH, 30);
      expect(await bob.getBalance()).to.equal(1110);
    });

    it("prohibits merging a shard with itself", async () => {
      const sw = await Shardwallet.deploy();
      // Will fail due to owner check on token #1 after it's been burned.
      await expect(sw.merge([1, 1])).to.be.revertedWith("ERC721:");
    });

    it("handles non-whole claim splits", async () => {
      const [alice] = await ethers.getSigners();
      const bob = ethers.Wallet.createRandom().connect(alice.provider);
      const sw = await Shardwallet.deploy();

      // Split the root shard into two, then split the first child again, so
      // that there are children whose siblings' shares add to less than unity.
      await sw.split(1, [
        { shareMicros: 100000, recipient: alice.address },
        { shareMicros: 900000, recipient: alice.address },
      ]);

      await alice.sendTransaction({ to: sw.address, value: 100 });
      await sw.claimTo(2, [ETH], bob.address);

      // (6.4, 2.2, 1.4) should round to (6, 2, 2).
      await sw.split(2, [
        { shareMicros: 64000, recipient: alice.address },
        { shareMicros: 22000, recipient: alice.address },
        { shareMicros: 14000, recipient: alice.address },
      ]);
      expect(await sw.callStatic.computeClaimed(4, ETH)).to.equal(6);
      expect(await sw.callStatic.computeClaimed(5, ETH)).to.equal(2);
      expect(await sw.callStatic.computeClaimed(6, ETH)).to.equal(2);

      // (6.4, 2.3, 1.3) should round to (7, 2, 1).
      await sw.merge([4, 5, 6]);
      await sw.split(7, [
        { shareMicros: 64000, recipient: alice.address },
        { shareMicros: 23000, recipient: alice.address },
        { shareMicros: 13000, recipient: alice.address },
      ]);
      expect(await sw.callStatic.computeClaimed(8, ETH)).to.equal(7);
      expect(await sw.callStatic.computeClaimed(9, ETH)).to.equal(2);
      expect(await sw.callStatic.computeClaimed(10, ETH)).to.equal(1);
    });

    it("properly distributes claims with multiple parents and children", async () => {
      const [alice] = await ethers.getSigners();
      const bob = ethers.Wallet.createRandom().connect(alice.provider);
      const sw = await Shardwallet.deploy();

      await alice.sendTransaction({ to: sw.address, value: 2 });

      await sw.split(1, [
        { shareMicros: 500000, recipient: alice.address },
        { shareMicros: 500000, recipient: alice.address },
      ]);
      await sw.claimTo(2, [ETH], bob.address);
      await sw.claimTo(3, [ETH], bob.address);
      await sw.reforge(
        [2, 3],
        [
          { shareMicros: 500000, recipient: alice.address },
          { shareMicros: 500000, recipient: alice.address },
        ]
      );

      // Shards 4 and 5 each have shards 2 and 3 as parents, and each parent
      // has claimed 1 unit. In isolation, any single parent would pass down
      // this claim to shard 5 (breaking a tie). But combined, the distribution
      // should be (1, 1), not (0, 2).
      //
      // That is, `computeClaimed` must call `splitClaim` just once after
      // adding the `claimed` values for each parent, rather than calling
      // `splitClaim` once per parent and adding the results.
      expect(await sw.callStatic.computeClaimed(4, ETH)).to.equal(1);
      expect(await sw.callStatic.computeClaimed(5, ETH)).to.equal(1);
    });

    it("behaves reasonably under a realistic sequence of operations", async () => {
      const [deployer] = await ethers.getSigners();
      const [alice, bob, camille, dolores] = Array(4)
        .fill()
        .map(() => ethers.Wallet.createRandom().connect(deployer.provider));
      const sw = await Shardwallet.deploy();
      const weth9 = await TestERC20.deploy();
      const dai = await TestERC20.deploy();

      // Give each signer some amount of gas money, and keep track of how much
      // gas they spend so that we can check that they've been distributed the
      // right amount of ETH.
      const gasFunds = new Map();
      for (const signer of [alice, bob, camille, dolores]) {
        const value = ethers.constants.WeiPerEther;
        await deployer.sendTransaction({ to: signer.address, value });
        gasFunds.set(signer.address, value);
      }
      async function countGas(txOrRx) {
        const rx = txOrRx.gasUsed != null ? txOrRx : await txOrRx.wait();
        const fee = rx.gasUsed.mul(rx.effectiveGasPrice);
        gasFunds.set(rx.from, gasFunds.get(rx.from).sub(fee));
      }

      await sw.split(1, [
        { shareMicros: 500000, recipient: alice.address },
        { shareMicros: 500000, recipient: bob.address },
      ]);
      await sw
        .connect(bob)
        .split(3, [
          { shareMicros: 300000, recipient: bob.address },
          { shareMicros: 100000, recipient: camille.address },
          { shareMicros: 100000, recipient: dolores.address },
        ])
        .then(countGas);
      const shards = [
        { shard: 2, bearer: alice, percent: 50 },
        { shard: 4, bearer: bob, percent: 30 },
        { shard: 5, bearer: camille, percent: 10 },
        { shard: 6, bearer: dolores, percent: 10 },
      ];

      // With a continuous incoming stream of funds, claim different amounts at
      // a time by different shards, in a triangular pattern.
      const justOver1Eth = ethers.BigNumber.from("1234567890123456789");
      for (let i = 0; i <= shards.length; i++) {
        await deployer.sendTransaction({ to: sw.address, value: justOver1Eth });
        await weth9.mint(sw.address, justOver1Eth);
        for (const { shard, bearer } of shards.slice(0, i)) {
          await sw
            .connect(bearer)
            .claim(shard, [ETH, weth9.address])
            .then(countGas);
        }
      }

      {
        const received = justOver1Eth.mul(shards.length + 1);
        const balances = await Promise.all(
          shards.map(async ({ bearer, percent }) => ({
            bearer,
            expected: received.mul(percent).div(100), // rounded down
            actualEth: await bearer
              .getBalance()
              .then((b) => b.sub(gasFunds.get(bearer.address))),
            actualWeth9: await weth9.balanceOf(bearer.address),
          }))
        );
        expect(
          balances.map((x) => ({
            address: x.bearer.address,
            eth: String(x.actualEth),
            weth9: String(x.actualWeth9),
          }))
        ).to.deep.equal(
          balances.map((x) => ({
            address: x.bearer.address,
            eth: String(x.expected),
            weth9: String(x.expected),
          }))
        );
        const distributed = balances.reduce(
          (acc, b) => acc.add(b.expected),
          ethers.constants.Zero
        );
        const dust = received.sub(distributed);
        expect(dust).to.be.lt(10).and.gt(0);
        expect(await deployer.provider.getBalance(sw.address)).to.equal(dust);
      }

      // Then, introduce a new currency to the mix while reforging the shards.
      const oneMillionDollars = ethers.BigNumber.from(10n ** (6n + 18n));
      await dai.mint(sw.address, oneMillionDollars);

      expect(shards.pop().shard).to.equal(6);
      await sw
        .connect(dolores)
        .split(6, [
          { shareMicros: 80000, recipient: dolores.address },
          { shareMicros: 20000, recipient: dolores.address },
        ])
        .then(countGas);
      shards.push({ shard: 7, bearer: dolores, percent: 8 });
      shards.push({ shard: 8, bearer: dolores, percent: 2 });
      await sw.connect(dolores).claim(7, [dai.address]).then(countGas);
      await sw
        .connect(dolores)
        .merge([shards.pop().shard, shards.pop().shard])
        .then(countGas);
      shards.push({ shard: 9, bearer: dolores, percent: 10 });
      // At this point, Dolores's shard has claimed 80% of its share of the
      // DAI, while the other shards have claimed none. Bring those all up.
      for (const { shard, bearer } of shards) {
        await sw.connect(bearer).claim(shard, [dai.address]).then(countGas);
      }

      {
        const balances = await Promise.all(
          shards.map(async ({ bearer, percent }) => ({
            bearer,
            expected: oneMillionDollars.mul(percent).div(100),
            actual: await dai.balanceOf(bearer.address),
          }))
        );
        expect(
          balances.map((x) => ({
            address: x.bearer.address,
            dai: String(x.actual),
          }))
        ).to.deep.equal(
          balances.map((x) => ({
            address: x.bearer.address,
            dai: String(x.expected),
          }))
        );
      }
    });
  });
});
