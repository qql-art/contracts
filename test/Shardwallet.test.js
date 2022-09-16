const { expect } = require("chai");

describe("Shardwallet", () => {
  let Nonpayable;
  let Shardwallet;
  let ShardwalletFactory;
  let TestERC20;
  let TestSplitClaim;
  let TestTokenUriDelegate;

  let swf;
  let testSplitClaim;

  const ETH = ethers.constants.AddressZero;
  const WeiPerEther = ethers.constants.WeiPerEther;

  before(async () => {
    Nonpayable = await ethers.getContractFactory("Nonpayable");
    Shardwallet = await ethers.getContractFactory("Shardwallet");
    ShardwalletFactory = await ethers.getContractFactory("ShardwalletFactory");
    TestERC20 = await ethers.getContractFactory("TestERC20");
    TestSplitClaim = await ethers.getContractFactory("TestSplitClaim");
    TestTokenUriDelegate = await ethers.getContractFactory(
      "TestTokenUriDelegate"
    );

    swf = await ShardwalletFactory.deploy();
    testSplitClaim = await TestSplitClaim.deploy();
  });

  async function summon() {
    const signer = swf.signer;
    const address = await signer.getAddress();
    const nonce = await swf.provider.getTransactionCount(address);
    const salt = address + nonce.toString(16).padStart(24, "0");
    const tx = await swf.summon(salt, "Shardwallet", "SHARD");
    const rx = await tx.wait();
    const events = rx.events.filter((e) => e.event === "ShardwalletCreation");
    if (events.length !== 1) {
      throw new Error(
        "expected exactly one ShardwalletCreation, got " + events.length
      );
    }
    const [event] = events;
    const sw = Shardwallet.attach(event.args.shardwallet);
    return { sw, deployTransaction: tx };
  }

  async function expectClaimableAmounts(sw, shardId, currencies, expected) {
    const actual = await sw.callStatic.claim(shardId, currencies);
    expect(actual).to.deep.equal(expected.map((x) => ethers.BigNumber.from(x)));
  }

  describe("basic operations", () => {
    it("permits claiming ETH and ERC-20s with a single shard", async () => {
      const [alice] = await ethers.getSigners();
      const bob = ethers.Wallet.createRandom().connect(alice.provider);
      const { sw, deployTransaction } = await summon();
      const erc20 = await TestERC20.deploy();

      expect(await sw.name()).to.equal("Shardwallet");
      expect(await sw.symbol()).to.equal("SHARD");

      expect(await sw.getParents(0)).to.deep.equal([]);
      expect(await sw.getParents(1)).to.deep.equal([]);
      expect(await sw.getShareMicros(1)).to.equal(1000000);

      await expect(deployTransaction)
        .to.emit(sw, "Transfer")
        .withArgs(ethers.constants.AddressZero, alice.address, 1);

      await alice.sendTransaction({ to: sw.address, value: 100 });
      await erc20.mint(sw.address, 500);

      expect(await sw.getDistributed(ETH)).to.equal(0);
      expect(await sw.getDistributed(erc20.address)).to.equal(0);

      // Deposit some ETH and ERC-20s, then claim.
      await expectClaimableAmounts(sw, 1, [ETH, erc20.address], [100, 500]);
      const claim1 = sw.claimTo(1, [ETH, erc20.address], bob.address);
      await claim1;
      await expect(claim1).to.emit(sw, "Claim").withArgs(1, ETH, 100);
      await expect(claim1).to.emit(sw, "Claim").withArgs(1, erc20.address, 500);
      expect(await bob.getBalance()).to.equal(100);
      expect(await erc20.balanceOf(bob.address)).to.equal(500);
      expect(await sw.getDistributed(ETH)).to.equal(100);
      expect(await sw.getDistributed(erc20.address)).to.equal(500);

      // Claim with no new funds.
      await expectClaimableAmounts(sw, 1, [ETH, erc20.address], [0, 0]);
      const claim2 = sw.claimTo(1, [ETH, erc20.address], bob.address);
      await claim2;
      await expect(claim2).to.emit(sw, "Claim").withArgs(1, ETH, 0);
      await expect(claim2).to.emit(sw, "Claim").withArgs(1, erc20.address, 0);

      // Deposit more funds, then claim again.
      await alice.sendTransaction({ to: sw.address, value: 50 });
      await erc20.mint(sw.address, 250);
      await expectClaimableAmounts(sw, 1, [ETH, erc20.address], [50, 250]);
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
      const { sw } = await summon();

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
      await expect(sw.callStatic.claim(1, [ETH])).to.be.revertedWith("ERC721:");

      expect(await sw.callStatic.computeClaimed(2, ETH)).to.equal(500);
      expect(await sw.callStatic.computeClaimed(3, ETH)).to.equal(300);
      expect(await sw.callStatic.computeClaimed(4, ETH)).to.equal(200);

      // Claim from two of the three new shards.
      await alice.sendTransaction({ to: sw.address, value: 100 });
      await expectClaimableAmounts(sw, 2, [ETH], [50]);
      await expectClaimableAmounts(sw, 3, [ETH], [30]);
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

      // Check accessors that are meant to operate for even inactive shards.
      expect(await sw.getParents(1)).to.deep.equal([]);
      expect(await sw.getParents(2)).to.deep.equal(
        [1].map(ethers.BigNumber.from)
      );
      expect(await sw.getParents(5)).to.deep.equal(
        [2, 3, 4].map(ethers.BigNumber.from)
      );
      expect(await sw.getShareMicros(1)).to.equal(1000000);
      expect(await sw.getShareMicros(2)).to.equal(500000);
      expect(await sw.getShareMicros(5)).to.equal(1000000);
    });

    it("handles non-whole claim splits", async () => {
      const [alice] = await ethers.getSigners();
      const bob = ethers.Wallet.createRandom().connect(alice.provider);
      const { sw } = await summon();

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
      const { sw } = await summon();

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
      const [deployer, alice, bob, camille, dolores] =
        await ethers.getSigners();
      const { sw } = await summon();
      const weth9 = await TestERC20.deploy();
      const dai = await TestERC20.deploy();

      // Keep track of how much ETH each signer started with, less gas spent
      // along the way, so that we can check that they've been distributed the
      // right amount of ETH.
      const expectedSurplus = new Map();
      for (const signer of [alice, bob, camille, dolores]) {
        expectedSurplus.set(signer.address, await signer.getBalance());
      }
      async function countGas(txOrRx) {
        const rx = txOrRx.gasUsed != null ? txOrRx : await txOrRx.wait();
        const fee = rx.gasUsed.mul(rx.effectiveGasPrice);
        expectedSurplus.set(rx.from, expectedSurplus.get(rx.from).sub(fee));
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
              .then((b) => b.sub(expectedSurplus.get(bearer.address))),
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

  describe("invalid operations", () => {
    // Share chain state for these tests, since they only make static calls.
    let alice, bob, sw;
    before(async () => {
      [alice, bob] = await ethers.getSigners();
      ({ sw } = await summon());
    });

    it("reverts when merging a shard with itself", async () => {
      // Will fail due to owner check on token #1 after it's been burned.
      await expect(sw.callStatic.merge([1, 1])).to.be.revertedWith("ERC721:");
    });

    it("reverts when attempting a merge of no shards", async () => {
      await expect(sw.callStatic.merge([])).to.be.revertedWith(
        "Shardwallet: no parents"
      );
      await expect(sw.callStatic.reforge([], [])).to.be.revertedWith(
        "Shardwallet: no parents"
      );
    });

    it("reverts if reforging would increase share", async () => {
      await expect(
        sw.callStatic.split(1, [
          { shareMicros: 500000, recipient: alice.address },
          { shareMicros: 500001, recipient: alice.address },
        ])
      ).to.be.revertedWith("Shardwallet: share too large");
    });

    it("reverts if reforging would decrease share", async () => {
      await expect(
        sw.callStatic.split(1, [
          { shareMicros: 500000, recipient: alice.address },
          { shareMicros: 499999, recipient: alice.address },
        ])
      ).to.be.revertedWith("Shardwallet: share too small");
    });

    it("reverts if attempting to create a zero-share shard", async () => {
      await expect(
        sw.callStatic.split(1, [
          { shareMicros: 500000, recipient: alice.address },
          { shareMicros: 500000, recipient: alice.address },
          { shareMicros: 0, recipient: alice.address },
        ])
      ).to.be.revertedWith("Shardwallet: null share");
    });

    it("reverts if attempting to reforge a shard owned by someone else", async () => {
      await expect(sw.connect(bob).callStatic.merge([1])).to.be.revertedWith(
        "Shardwallet: unauthorized"
      );
    });

    it("reverts if attempting to claim for a shard owned by someone else", async () => {
      // (This is prohibited even though there's no ETH to claim right now.)
      await expect(
        sw.connect(bob).callStatic.claim(1, [ETH])
      ).to.be.revertedWith("Shardwallet: unauthorized");
    });
  });

  describe("splitClaim", () => {
    async function expectSplitClaim(amount, shareMicros, expected) {
      const actual = await testSplitClaim.splitClaimBatch(amount, shareMicros);
      function normalize(xs) {
        return xs.map((x) => String(ethers.BigNumber.from(x)));
      }
      expect(normalize(actual)).to.deep.equal(normalize(expected));
    }

    const cases = [
      {
        name: "basic two-way split, 50%/50%",
        amount: 10,
        shareMicros: [50e4, 50e4],
        expected: [5, 5],
      },
      {
        name: "two-way split with dust",
        amount: 9,
        shareMicros: [50e4, 50e4],
        expected: [4, 5],
      },
      {
        name: "10%/20% split (sub-100% parent)",
        amount: 10,
        shareMicros: [10e4, 20e4],
        expected: [3, 7],
      },
      {
        name: "three-way split with no dust, 10%/10%/5% (sub-100% parent)",
        amount: 10,
        shareMicros: [10e4, 10e4, 5e4],
        expected: [4, 4, 2],
      },
      {
        name: "three-way split with dust, 50%/25%/25%",
        amount: 10,
        shareMicros: [50e4, 25e4, 25e4],
        expected: [5, 2, 3],
      },
      {
        name: "three-way split with no dust, 12 wei into 7%/7%/7%",
        amount: 12,
        shareMicros: [7e4, 7e4, 7e4],
        expected: [4, 4, 4],
      },
      {
        name: "five-way split with multiple dust recipients",
        amount: 10,
        shareMicros: [40e4, 15e4, 15e4, 15e4, 15e4],
        expected: [4, 1, 1, 2, 2],
      },
      {
        name: "six-way split with multiple dust recipients",
        amount: 10,
        shareMicros: [20e4, 15e4, 15e4, 15e4, 15e4, 20e4],
        expected: [2, 1, 1, 2, 2, 2],
      },
      {
        name: "basic four-way split with even division",
        amount: 10,
        shareMicros: [20e4, 30e4, 30e4, 20e4],
        expected: [2, 3, 3, 2],
      },
      {
        name: "64%/22%/14% split with dust to the 14% shard",
        amount: 10,
        shareMicros: [64e4, 22e4, 14e4],
        expected: [6, 2, 2],
      },
      {
        name: "64%/23%/13% split with dust to the 64% shard",
        amount: 10,
        shareMicros: [64e4, 23e4, 13e4],
        expected: [7, 2, 1],
      },
      {
        name: "1B ETH (10**27 wei) into a 10%/10% split",
        amount: WeiPerEther.mul(1e9),
        shareMicros: [10e4, 10e4],
        expected: [WeiPerEther.mul(0.5e9), WeiPerEther.mul(0.5e9)],
      },
      {
        name: "1B ETH (10**27 wei) into a 1micro/1micro split",
        amount: WeiPerEther.mul(1e9),
        shareMicros: [1, 1],
        expected: [WeiPerEther.mul(0.5e9), WeiPerEther.mul(0.5e9)],
      },
      //...
    ];

    for (const { name, amount, shareMicros, expected } of cases) {
      it(name, async () => {
        await expectSplitClaim(amount, shareMicros, expected);
      });
    }
  });

  describe("edge cases", () => {
    it("reverts if an ERC-20 transfer silently returns `false`", async () => {
      const { sw } = await summon();
      const erc20 = await TestERC20.deploy();
      await erc20.mint(sw.address, 1);
      await erc20.setSilentlyFailing(true);
      await expect(sw.claim(1, [erc20.address])).to.be.revertedWith(
        "Shardwallet: transfer failed"
      );
    });

    it("reverts if an ERC-20 transfer reverts", async () => {
      const { sw } = await summon();
      const erc20 = await TestERC20.deploy();
      await erc20.mint(sw.address, 1);
      await erc20.setReverting(true);
      await expect(sw.claim(1, [erc20.address])).to.be.revertedWith(
        "TestERC20: revert!"
      );
    });

    it("reverts if an ETH transfer reverts", async () => {
      const [alice] = await ethers.getSigners();
      const { sw } = await summon();
      const nonpayable = await Nonpayable.deploy();
      await alice.sendTransaction({ to: sw.address, value: 1 });
      await expect(sw.claimTo(1, [ETH], nonpayable.address)).to.be.revertedWith(
        "Nonpayable: revert!"
      );
    });

    it("distributes what it can if ERC-20 balance has been reduced", async () => {
      const [alice] = await ethers.getSigners();
      const { sw } = await summon();
      const erc20 = await TestERC20.deploy();

      await sw.split(1, [
        { shareMicros: 800000, recipient: alice.address }, // shard 2
        { shareMicros: 200000, recipient: alice.address }, // shard 3
      ]);
      await erc20.mint(sw.address, 1000000);
      await expect(sw.claim(2, [erc20.address]))
        .to.emit(sw, "Claim")
        .withArgs(2, erc20.address, 800000);

      // Suppose that the ERC-20 token has some owner override that allows
      // burning tokens of an arbitrary account. Then the Shardwallet should
      // still try to withdraw what it can.
      await erc20.burn(sw.address, 100000); // 200k -> 100k
      await expect(sw.claim(3, [erc20.address]))
        .to.emit(sw, "Claim")
        .withArgs(3, erc20.address, 100000); // all that's available
      expect(await sw.callStatic.computeClaimed(3, erc20.address)).to.equal(
        100000
      );
      expect(await sw.getDistributed(erc20.address)).to.equal(900000);

      // Now, recover the burned 100k and add another 1M; the wallet should
      // return to equilibrium.
      await erc20.mint(sw.address, 1100000);
      await expect(sw.claim(3, [erc20.address]))
        .to.emit(sw, "Claim")
        .withArgs(3, erc20.address, 300000); // 100k recovered, 200k new

      expect(await erc20.balanceOf(alice.address)).to.equal(1200000);
      expect(await erc20.balanceOf(sw.address)).to.equal(800000);
    });

    it("overflows the stack when computing a deep enough claim, recoverably", async () => {
      const [alice] = await ethers.getSigners();
      const { sw } = await summon();
      let shard = 1;
      while (true) {
        const reverts = await sw.callStatic
          .computeClaimed(shard, ETH)
          .then(() => false)
          .catch(() => true);
        if (reverts) break;
        // The EVM has a stack size limit of 1024 entries, and each frame of
        // `computeClaimed` uses at least a few words, so we should be able to
        // induce a stack overflow before too long.
        if (shard > 1024) throw new Error("couldn't induce stack overflow");
        for (let i = 0; i < 32; i++) {
          await sw.split(shard, [
            { shareMicros: 1000000, recipient: alice.address },
          ]);
          shard++;
        }
      }

      // Directly computing the claim reverts.
      await expect(sw.callStatic.computeClaimed(shard, ETH)).to.be.reverted;
      // But if we first populate the results for some ancestors...
      for (let i = 0; i < shard; i += 64) {
        await sw.computeClaimed(i, ETH);
        const claim = await sw.callStatic.computeClaimed(i, ETH).then(String);
        expect({ i, claim }).to.deep.equal({ i, claim: "0" });
      }
      // ...then we can eventually get the right answer.
      expect(await sw.callStatic.computeClaimed(shard, ETH)).to.equal(0);
    });

    it("can only be initialized once", async () => {
      const [alice] = await ethers.getSigners();
      const { sw } = await summon();
      await expect(sw.initialize(alice.address, "", "")).to.be.revertedWith(
        "Initializable:"
      );
    });
  });

  describe("token URI delegate", () => {
    it("works when set or unset, with active and inactive shards", async () => {
      const [alice] = await ethers.getSigners();
      const { sw } = await summon();
      await sw.split(1, [
        { shareMicros: 100000, recipient: alice.address },
        { shareMicros: 900000, recipient: alice.address },
      ]);

      await expect(sw.tokenURI(1)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );
      expect(await sw.tokenURI(2)).to.equal("");

      const uriDelegate = await TestTokenUriDelegate.deploy();
      await sw.setTokenUriDelegate(uriDelegate.address);
      expect(await sw.tokenUriDelegate()).to.equal(uriDelegate.address);

      await expect(sw.tokenURI(1)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );
      expect(await sw.tokenURI(2)).to.equal(
        `data:text/plain,${sw.address.toLowerCase()}%20%232`
      );
    });
  });

  describe("supportsInterface", () => {
    let sw;
    before(async () => {
      ({ sw } = await summon());
    });

    const cases = [
      ["ERC165", 0x01ffc9a7, true],
      ["ERC721", 0x80ac58cd, true],
      ["ERC721Enumerable", 0x780e9d63, true],
      ["ERC721Metadata", 0x5b5e139f, true],
      ["false sentinel", 0xffffffff, false],
    ];

    for (const [name, id, impl] of cases) {
      it(`${impl ? "implements" : "does not implement"} ${name}`, async () => {
        expect(await sw.supportsInterface(id)).to.equal(impl);
      });
    }
  });
});
