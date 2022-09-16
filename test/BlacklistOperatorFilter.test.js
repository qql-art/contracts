const { expect } = require("chai");

describe("BlacklistOperatorFilter", () => {
  let BlacklistOperatorFilter;
  let TransferProxy;

  before(async () => {
    BlacklistOperatorFilter = await ethers.getContractFactory(
      "BlacklistOperatorFilter"
    );
    TransferProxy = await ethers.getContractFactory("TransferProxy");
  });

  it("lets everyone through by default", async () => {
    const filter = await BlacklistOperatorFilter.deploy();
    const p1 = await TransferProxy.deploy();
    const [alice, bob] = await ethers.getSigners();

    expect(await filter.mayTransfer(alice.address)).to.equal(true);
    expect(await filter.mayTransfer(bob.address)).to.equal(true);
    expect(await filter.mayTransfer(filter.address)).to.equal(true);
    expect(await filter.mayTransfer(p1.address)).to.equal(true);
    expect(await filter.mayTransfer(ethers.constants.AddressZero)).to.equal(
      true
    );
  });

  it("permits blocking specific addresses", async () => {
    const filter = await BlacklistOperatorFilter.deploy();
    const p1 = await TransferProxy.deploy();
    const p2 = await TransferProxy.deploy();
    await filter.setAddressBlocked(p1.address, true);
    expect(await filter.mayTransfer(p1.address)).to.equal(false);
    expect(await filter.mayTransfer(p2.address)).to.equal(true);
    expect(await filter.isAddressBlocked(p1.address)).to.equal(true);
    expect(await filter.isAddressBlocked(p2.address)).to.equal(false);
  });

  it("permits blocking contracts by implementation", async () => {
    const filter = await BlacklistOperatorFilter.deploy();
    const p1 = await TransferProxy.deploy();
    const p2 = await TransferProxy.deploy();
    const codeHash = await filter.codeHashOf(p1.address);
    await filter.setCodeHashBlocked(codeHash, true);

    expect(await filter.mayTransfer(p1.address)).to.equal(false);
    expect(await filter.mayTransfer(p2.address)).to.equal(false);
    expect(await filter.mayTransfer(filter.address)).to.equal(true);
    expect(await filter.isAddressBlocked(p1.address)).to.equal(false);
    expect(await filter.isCodeHashBlocked(codeHash)).to.equal(true);
  });

  it("forbids blocking all EOAs (accounts with empty code)", async () => {
    const filter = await BlacklistOperatorFilter.deploy();
    const [alice, bob] = await ethers.getSigners();
    const codeHash = await filter.codeHashOf(alice.address);
    expect(codeHash).to.equal(ethers.utils.keccak256([]));
    await expect(filter.setCodeHashBlocked(codeHash, true)).to.be.revertedWith(
      "BlacklistOperatorFilter: can't block EOAs"
    );
    expect(await filter.mayTransfer(alice.address)).to.equal(true);
  });

  it("only permits the owner to change state", async () => {
    const filter = await BlacklistOperatorFilter.deploy();
    const [owner, notOwner] = await ethers.getSigners();
    await expect(
      filter
        .connect(notOwner)
        .setAddressBlocked(ethers.constants.AddressZero, true)
    ).to.be.revertedWith("Ownable:");
    await expect(
      filter
        .connect(notOwner)
        .setCodeHashBlocked(ethers.constants.HashZero, true)
    ).to.be.revertedWith("Ownable:");
  });
});
