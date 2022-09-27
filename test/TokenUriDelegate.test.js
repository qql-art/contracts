const { expect } = require("chai");

describe("TokenUriDelegate", () => {
  before(async () => {
    TokenUriDelegate = await ethers.getContractFactory("TokenUriDelegate");
  });

  it("gives a coherent response when unset", async () => {
    const tud = await TokenUriDelegate.deploy();
    expect(await tud.tokenURI(1)).to.equal("1");
  });

  it("allows setting the baseURI", async () => {
    const tud = await TokenUriDelegate.deploy();
    await tud.setBaseURI("https://token.qql.art/mintpass/");
    expect(await tud.tokenURI(1)).to.equal("https://token.qql.art/mintpass/1");
  });

  it("only owner can set the baseURI", async () => {
    const signers = await ethers.getSigners();
    const tud = await TokenUriDelegate.deploy();
    const fail = tud.connect(signers[1]).setBaseURI("1800-scams-dot-com");
    await expect(fail).to.be.revertedWith("not the owner");
  });
});
