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
        .to.emit(sw, "Split")
        .withArgs(1, 2, [500000, 300000, 200000]);

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
      await expect(merge).to.emit(sw, "Merge").withArgs(5, [2, 3, 4]);
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
  });
});
