const { expect } = require("chai");

describe("NameRegistry", () => {
  let MintPass;
  let NameRegistry;
  let QQL;
  before(async () => {
    MintPass = await ethers.getContractFactory("MintPass");
    NameRegistry = await ethers.getContractFactory("NameRegistry");
    QQL = await ethers.getContractFactory("QQL");
  });

  const ArtistNameApproval = [
    { name: "artist", type: "address" },
    { name: "name", type: "string" },
  ];
  const TokenNameApproval = [
    { name: "tokenId", type: "uint256" },
    { name: "name", type: "string" },
  ];

  function generateSeed(address, rest) {
    return ethers.utils.solidityPack(["address", "uint96"], [address, rest]);
  }

  async function setUp() {
    const [owner, coArtist, controller, artist, holder] =
      await ethers.getSigners();
    const mp = await MintPass.deploy(3);
    const qql = await QQL.deploy(mp.address, 0, 0);
    await mp.setBurner(qql.address);
    await mp.reserve(owner.address, 3);
    await qql.mintTo(1, generateSeed(owner.address, 0), owner.address);
    await qql.mintTo(2, generateSeed(coArtist.address, 0), coArtist.address);
    await qql.connect(artist).approveForAllSeeds(holder.address, true);
    await qql.mintTo(3, generateSeed(artist.address, 0), holder.address);
    const nr = await NameRegistry.deploy(qql.address);
    await nr.connect(coArtist).setController(2, controller.address);
    const domain = {
      name: "NameRegistry",
      version: "1",
      chainId: await owner.getChainId(),
      verifyingContract: nr.address,
    };
    return { mp, qql, nr, domain, owner, controller, artist, holder };
  }

  describe("reports EIP-712", () => {
    let nr, domain, artist;
    before(async () => {
      ({ nr, domain, artist } = await setUp());
    });

    it("domain separator", async () => {
      const expected = ethers.utils._TypedDataEncoder.hashDomain(domain);
      const actual = await nr.domainSeparator();
      expect(actual).to.equal(expected);
    });

    it("struct hash for ArtistNameApproval", async () => {
      const name = "Alice";
      const expected = ethers.utils._TypedDataEncoder.hashStruct(
        "ArtistNameApproval",
        { ArtistNameApproval },
        { artist: artist.address, name }
      );
      const actual = await nr.artistNameApprovalStructHash(
        artist.address,
        name
      );
      expect(actual).to.equal(expected);
    });

    it("struct hash for TokenNameApproval", async () => {
      const tokenId = 3;
      const name = "Autumn Leaves";
      const expected = ethers.utils._TypedDataEncoder.hashStruct(
        "TokenNameApproval",
        { TokenNameApproval },
        { tokenId, name }
      );
      const actual = await nr.tokenNameApprovalStructHash(tokenId, name);
      expect(actual).to.equal(expected);
    });
  });

  it("allows setting artist name", async () => {
    const { nr, domain, controller, artist } = await setUp();
    const name = "Alice";
    const sig = await controller._signTypedData(
      domain,
      { ArtistNameApproval },
      { artist: artist.address, name }
    );
    await expect(nr.connect(artist).setArtistName(name, 2, sig))
      .to.emit(nr, "ArtistName")
      .withArgs(artist.address, name, name);
    await expect(await nr.artistName(artist.address)).to.equal("Alice");
  });

  it("allows setting token name", async () => {
    const { nr, qql, domain, controller, holder, artist } = await setUp();
    const tokenId = 3;
    const name = "Autumn Leaves";
    const sig = await controller._signTypedData(
      domain,
      { TokenNameApproval },
      { tokenId, name }
    );
    await expect(nr.connect(artist).setTokenName(tokenId, name, 2, sig))
      .to.emit(nr, "TokenName")
      .withArgs(tokenId, name, name);
    await expect(await nr.tokenName(tokenId)).to.equal(name);
  });
});
