const { expect } = require("chai");

const BN = ethers.BigNumber;

describe("SeedMarket", () => {
  const DEFAULT_FEE = 10;

  let MintPass;
  let QQL;
  let SeedMarket;
  let TestWeth;
  before(async () => {
    MintPass = await ethers.getContractFactory("MintPass");
    QQL = await ethers.getContractFactory("QQL");
    SeedMarket = await ethers.getContractFactory("SeedMarket");
    TestWeth = await ethers.getContractFactory("TestWeth");
  });

  function generateSeed(address, rest) {
    return ethers.utils.solidityPack(["address", "uint96"], [address, rest]);
  }

  async function setUp() {
    const [owner, artist, holder, alice, bob] = await ethers.getSigners();

    const seed = generateSeed(artist.address, 0);
    const seed2 = generateSeed(artist.address, 2);

    const mp = await MintPass.deploy(3);
    const qql = await QQL.deploy(mp.address, 0, 0);
    const weth = await TestWeth.deploy();
    const sm = await SeedMarket.deploy(
      qql.address,
      mp.address,
      weth.address,
      DEFAULT_FEE
    );
    await mp.setBurner(qql.address);
    await mp.reserve(holder.address, 3);

    await qql.connect(artist).approveForAllSeeds(sm.address, true);
    await mp.connect(holder).setApprovalForAll(sm.address, true);

    return {
      mp,
      qql,
      weth,
      sm,
      owner,
      artist,
      holder,
      alice,
      bob,
      seed,
      seed2,
    };
  }

  describe("blessings of the SeedMarket", async () => {
    it("a seed may be blessed", async () => {
      const { sm, artist, seed } = await setUp();
      expect(await sm.isBlessed(seed)).to.equal(false);
      await sm.connect(artist).bless(seed, { value: DEFAULT_FEE });
      expect(await sm.isBlessed(seed)).to.equal(true);
    });
    it("emits a Blessing event", async () => {
      const { sm, artist, seed } = await setUp();
      const go = sm.connect(artist).bless(seed, { value: DEFAULT_FEE });
      await expect(go).to.emit(sm, "Blessing").withArgs(seed, artist.address);
    });
    it("may be done by a seed operator", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      await qql.connect(artist).approveForAllSeeds(alice.address, true);
      const go = sm.connect(alice).bless(seed, { value: DEFAULT_FEE });
      await expect(go).to.emit(sm, "Blessing").withArgs(seed, alice.address);
    });
    it("may be done by a seed owner who is not artist", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      await qql
        .connect(artist)
        .transferSeed(artist.address, alice.address, seed);
      const go = sm.connect(alice).bless(seed, { value: DEFAULT_FEE });
      await expect(go).to.emit(sm, "Blessing").withArgs(seed, alice.address);
    });
    it("may be done by a parametric artist who is not the owner", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      await qql
        .connect(artist)
        .transferSeed(artist.address, alice.address, seed);
      const go = sm.connect(artist).bless(seed, { value: DEFAULT_FEE });
      await expect(go).to.emit(sm, "Blessing").withArgs(seed, artist.address);
    });
    it("may not be done without consent of the artist or operator", async () => {
      const { sm, artist, bob, seed } = await setUp();
      const fail = sm.connect(bob).bless(seed, { value: DEFAULT_FEE });
      await expect(fail).to.be.revertedWith("unauthorized");
    });
    it("reverts if the seed is already blessed", async () => {
      //
      const { sm, artist, bob, seed } = await setUp();
      await sm.connect(artist).bless(seed, { value: DEFAULT_FEE });
      const fail = sm.connect(artist).bless(seed, { value: DEFAULT_FEE });
      await expect(fail).to.be.revertedWith("already blessed");
    });
    it("reverts if the fee is too small", async () => {
      const { sm, artist, seed } = await setUp();
      const fail = sm.connect(artist).bless(seed);
      await expect(fail).to.be.revertedWith("wrong fee");
    });
    it("reverts if the fee is too large", async () => {
      const { sm, artist, seed } = await setUp();
      const fail = sm.connect(artist).bless(seed, { value: DEFAULT_FEE * 2 });
      await expect(fail).to.be.revertedWith("wrong fee");
    });
  });

  describe("blessing fees", async () => {
    it("only owner may change the fee", async () => {
      const { owner, sm, artist, seed } = await setUp();
      const fail = sm.connect(artist).setBlessingFee(150);
      await expect(fail).to.be.revertedWith("Ownable:");
    });
    it("fee may be changed", async () => {
      const { owner, sm, artist, seed } = await setUp();
      await sm.setBlessingFee(150);
      await sm.connect(artist).bless(seed, { value: 150 });
    });
    it("fee may be set to 0", async () => {
      const { owner, sm, artist, seed } = await setUp();
      await sm.setBlessingFee(0);
      await sm.connect(artist).bless(seed);
    });
  });

  describe("list", async () => {
    it("requires that the seed be blessed", async () => {
      const { owner, sm, artist, seed } = await setUp();
      const fail = sm.connect(artist).list(seed, 12);
      await expect(fail).to.be.revertedWith("must bless to list");
    });
    it("is retrievable via getListing", async () => {
      const { owner, sm, artist, seed } = await setUp();
      await sm.connect(artist).blessAndList(seed, 12, { value: DEFAULT_FEE });
      expect(await sm.isBlessed(seed)).to.equal(true);
      expect(await sm.getListing(seed)).to.deep.equal([
        artist.address,
        BN.from(12),
      ]);
    });
    it("emits a Listing event", async () => {
      const { sm, artist, seed } = await setUp();
      const go = sm
        .connect(artist)
        .blessAndList(seed, 12, { value: DEFAULT_FEE });
      await expect(go)
        .to.emit(sm, "Listing")
        .withArgs(seed, artist.address, 12);
    });
    it("works for seed owner", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      await qql
        .connect(artist)
        .transferSeed(artist.address, alice.address, seed);
      await qql.connect(alice).approveForAllSeeds(sm.address, true);
      const go = sm
        .connect(alice)
        .blessAndList(seed, 12, { value: DEFAULT_FEE });
      await expect(go).to.emit(sm, "Listing").withArgs(seed, alice.address, 12);
    });
    it("works for seed operator", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      await qql.connect(artist).approveForAllSeeds(alice.address, true);
      const go = sm
        .connect(alice)
        .blessAndList(seed, 12, { value: DEFAULT_FEE });
      await expect(go).to.emit(sm, "Listing").withArgs(seed, alice.address, 12);
    });
    it("transfers the seed to the marketplace", async () => {
      const { owner, sm, artist, seed, qql } = await setUp();
      await sm.connect(artist).blessAndList(seed, 12, { value: DEFAULT_FEE });
      expect(await qql.ownerOfSeed(seed)).to.equal(sm.address);
    });
    it("reverts if the piece is already listed", async () => {
      const { owner, sm, artist, seed, qql } = await setUp();
      await sm.connect(artist).blessAndList(seed, 12, { value: DEFAULT_FEE });
      const fail = sm.connect(artist).list(seed, 12, { value: DEFAULT_FEE });
      await expect(fail).to.be.revertedWith("unauthorized");
    });
    it("reverts if sender is not seed owner or operator", async () => {
      // nb. use parametric artist as the test case
      const { owner, sm, artist, alice, seed, qql } = await setUp();
      await qql
        .connect(artist)
        .transferSeed(artist.address, alice.address, seed);
      const fail = sm
        .connect(artist)
        .blessAndList(seed, 12, { value: DEFAULT_FEE });
      await expect(fail).to.be.revertedWith("unauthorized");
    });
    it("works on a delisted piece", async () => {
      const { owner, sm, artist, seed, qql } = await setUp();
      await sm.connect(artist).blessAndList(seed, 12, { value: DEFAULT_FEE });
      await sm.connect(artist).delist(seed);
      await sm.connect(artist).list(seed, 13);
    });
  });

  describe("reprice", async () => {
    it("emits a Listing event", async () => {
      const { sm, artist, seed } = await setUp();
      await sm.connect(artist).blessAndList(seed, 12, { value: DEFAULT_FEE });
      const go = await sm.connect(artist).reprice(seed, 13);
      await expect(go)
        .to.emit(sm, "Listing")
        .withArgs(seed, artist.address, 13);
    });
    it("getListing updates accordingly", async () => {
      const { sm, artist, seed } = await setUp();
      await sm.connect(artist).blessAndList(seed, 12, { value: DEFAULT_FEE });
      await sm.connect(artist).reprice(seed, 13);
      expect(await sm.getListing(seed)).to.deep.equal([
        artist.address,
        BN.from(13),
      ]);
    });
    it("fails on a seed that was not listed", async () => {
      const { sm, artist, seed } = await setUp();
      const fail = sm.connect(artist).reprice(seed, 12);
      await expect(fail).to.be.revertedWith("unauthorized");
    });
    it("fails if someone other than lister tries to call it", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      await qql
        .connect(artist)
        .transferSeed(artist.address, alice.address, seed);
      await qql.connect(alice).approveForAllSeeds(sm.address, true);
      await sm.connect(alice).blessAndList(seed, 12, { value: DEFAULT_FEE });
      const fail = sm.connect(artist).reprice(seed, 12);
      await expect(fail).to.be.revertedWith("unauthorized");
    });
  });

  describe("delist", async () => {
    it("emits Delisting event", async () => {
      const { sm, artist, seed } = await setUp();
      await sm.connect(artist).blessAndList(seed, 12, { value: DEFAULT_FEE });
      const go = sm.connect(artist).delist(seed);
      await expect(go).to.emit(sm, "Delisting").withArgs(seed);
    });
    it("getListing is updated accordingly", async () => {
      const { sm, artist, seed } = await setUp();
      await sm.connect(artist).blessAndList(seed, 12, { value: DEFAULT_FEE });
      await sm.connect(artist).delist(seed);
      expect(await sm.getListing(seed)).to.deep.equal([
        ethers.constants.AddressZero,
        BN.from(12),
      ]);
    });
    it("seed is transferred back to the lister", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      await qql
        .connect(artist)
        .transferSeed(artist.address, alice.address, seed);
      await qql.connect(alice).approveForAllSeeds(sm.address, true);
      await sm.connect(alice).blessAndList(seed, 12, { value: DEFAULT_FEE });
      await sm.connect(alice).delist(seed);
      expect(await qql.ownerOfSeed(seed)).to.equal(alice.address);
    });
    it("may only be called by the lister", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      await qql
        .connect(artist)
        .transferSeed(artist.address, alice.address, seed);
      await qql.connect(alice).approveForAllSeeds(sm.address, true);
      await sm.connect(alice).blessAndList(seed, 12, { value: DEFAULT_FEE });
      const fail = sm.connect(artist).delist(seed);
      await expect(fail).to.be.revertedWith("unauthorized");
    });
    it("reverts if the seed was not listed", async () => {
      const { sm, artist, alice, seed, qql } = await setUp();
      const fail = sm.connect(artist).delist(seed);
      await expect(fail).to.be.revertedWith("unauthorized");
    });
  });
});
