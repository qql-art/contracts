const { expect } = require("chai");

function testTokenUriDelegate(
  setUp /*: () => Promise<{ contract: Contract, owner: Signer, nonOwner: Signer, tokenId: string, nonTokenId: string }> */
) {
  describe("token URI delegate", () => {
    let TestTokenUriDelegate;
    before(async () => {
      TestTokenUriDelegate = await ethers.getContractFactory(
        "TestTokenUriDelegate"
      );
    });

    it("delegate can be set by the owner", async () => {
      const { contract, owner } = await setUp();
      const uriDelegate = await TestTokenUriDelegate.deploy();
      await contract.connect(owner).setTokenUriDelegate(uriDelegate.address);
      expect(await contract.tokenUriDelegate()).to.equal(uriDelegate.address);
    });

    it("delegate can't be set by non-owners", async () => {
      const { contract, owner, nonOwner } = await setUp();
      const uriDelegate = await TestTokenUriDelegate.deploy();
      await expect(
        contract.connect(nonOwner).setTokenUriDelegate(uriDelegate.address)
      ).to.be.revertedWith("Ownable:");
      expect(await contract.tokenUriDelegate()).to.equal(
        ethers.constants.AddressZero
      );
    });

    it("works when set or unset, with extant and non-existent tokens", async () => {
      const { contract, owner, tokenId, nonTokenId } = await setUp();

      expect(await contract.tokenURI(tokenId)).to.equal("");
      await expect(contract.tokenURI(nonTokenId)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );

      const uriDelegate = await TestTokenUriDelegate.deploy();
      await contract.connect(owner).setTokenUriDelegate(uriDelegate.address);

      expect(await contract.tokenURI(tokenId)).to.equal(
        `data:text/plain,${contract.address.toLowerCase()}%20%23${tokenId}`
      );
      await expect(contract.tokenURI(nonTokenId)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );
    });
  });
}

module.exports = testTokenUriDelegate;
