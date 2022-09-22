const { expect } = require("chai");

function testOperatorFilter(
  setUp /*: () => Promise<{ contract: Contract, owner: Signer, nonOwner: Signer, tokenHolder: Signer, tokenId: Signer }> */
) {
  describe("transfer operator filter", () => {
    let BlacklistOperatorFilter;
    let TransferProxy;
    before(async () => {
      BlacklistOperatorFilter = await ethers.getContractFactory(
        "BlacklistOperatorFilter"
      );
      TransferProxy = await ethers.getContractFactory("TransferProxy");
    });

    const recipient = "0x" + "55".repeat(20);

    it("filter can be set by the owner", async () => {
      const { contract, owner } = await setUp();
      const filter = await BlacklistOperatorFilter.deploy();
      await contract.connect(owner).setOperatorFilter(filter.address);
      expect(await contract.operatorFilter()).to.equal(filter.address);
    });

    it("filter can't be set by non-owners", async () => {
      const { contract, owner, nonOwner } = await setUp();
      const filter = await BlacklistOperatorFilter.deploy();
      await expect(
        contract.connect(nonOwner).setOperatorFilter(filter.address)
      ).to.be.revertedWith("Ownable:");
      expect(await contract.operatorFilter()).to.equal(
        ethers.constants.AddressZero
      );
    });

    it("always permits the owner to transfer their token", async () => {
      const { contract, owner, tokenHolder, tokenId } = await setUp();
      const filter = await BlacklistOperatorFilter.deploy();
      await contract.connect(owner).setOperatorFilter(filter.address);
      await filter.setAddressBlocked(tokenHolder.address, true);
      expect(await filter.mayTransfer(tokenHolder.address)).to.equal(false);
      // Should be allowed even though the operator is blacklisted, because the
      // operator is also the owner.
      await contract
        .connect(tokenHolder)
        .transferFrom(tokenHolder.address, recipient, tokenId);
      expect(await contract.ownerOf(tokenId)).to.equal(recipient);
    });

    it("always allows transferring tokens when no filter is set", async () => {
      const { contract, owner, tokenHolder, tokenId } = await setUp();
      const proxy = await TransferProxy.deploy();
      await contract
        .connect(tokenHolder)
        .setApprovalForAll(proxy.address, true);
      await proxy
        .connect(tokenHolder)
        .transferFrom(
          contract.address,
          tokenHolder.address,
          recipient,
          tokenId
        );
      expect(await contract.ownerOf(tokenId)).to.equal(recipient);
    });

    it("permits some other operators to transfer tokens", async () => {
      const { contract, owner, tokenHolder, tokenId } = await setUp();
      // Install a filter, but don't block anything.
      const filter = await BlacklistOperatorFilter.deploy();
      await contract.connect(owner).setOperatorFilter(filter.address);
      const proxy = await TransferProxy.deploy();
      await contract
        .connect(tokenHolder)
        .setApprovalForAll(proxy.address, true);
      await proxy
        .connect(tokenHolder)
        .transferFrom(
          contract.address,
          tokenHolder.address,
          recipient,
          tokenId
        );
      expect(await contract.ownerOf(tokenId)).to.equal(recipient);
    });

    it("blocks some other operators from transferring tokens", async () => {
      const { contract, owner, tokenHolder, tokenId } = await setUp();
      const filter = await BlacklistOperatorFilter.deploy();
      await contract.connect(owner).setOperatorFilter(filter.address);
      const proxy = await TransferProxy.deploy();
      await contract
        .connect(tokenHolder)
        .setApprovalForAll(proxy.address, true);
      await filter.setAddressBlocked(proxy.address, true);
      await expect(
        proxy
          .connect(tokenHolder)
          .transferFrom(
            contract.address,
            tokenHolder.address,
            recipient,
            tokenId
          )
      ).to.be.revertedWith("ERC721OperatorFilter: illegal operator");
      expect(await contract.ownerOf(tokenId)).to.equal(tokenHolder.address);
    });
  });
}

module.exports = testOperatorFilter;
