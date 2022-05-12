const { expect } = require("chai");

describe("TicketTrio", () => {
  it("owner can mint all tickets", async () => {
    const TicketTrio = await ethers.getContractFactory("TicketTrio");
    const ticketTrio = await TicketTrio.deploy(10);
    await ticketTrio.deployed();
    await ticketTrio.mintAll();
    const signers = await ethers.getSigners();
    expect(await ticketTrio.balanceOf(signers[0].address)).to.equal(10);
  });
  it("non-owner can't mint tickets", async () => {
    const TicketTrio = await ethers.getContractFactory("TicketTrio");
    const ticketTrio = await TicketTrio.deploy(10);
    await ticketTrio.deployed();
    const signers = await ethers.getSigners();
    const mintAll = ticketTrio.connect(signers[1]).mintAll();
    expect(mintAll).to.be.revertedWith("caller is not the owner");
  });
  it("tickets may be burned", async () => {
    const TicketTrio = await ethers.getContractFactory("TicketTrio");
    const ticketTrio = await TicketTrio.deploy(2);
    await ticketTrio.deployed();
    await ticketTrio.mintAll();
    await ticketTrio.burn(0);
    const signers = await ethers.getSigners();
    expect(await ticketTrio.balanceOf(signers[0].address)).to.equal(1);
  });
  it("unaffiliated actor can't burn ticket", async () => {
    const TicketTrio = await ethers.getContractFactory("TicketTrio");
    const ticketTrio = await TicketTrio.deploy(2);
    await ticketTrio.deployed();
    await ticketTrio.mintAll();
    const signers = await ethers.getSigners();
    const burn = ticketTrio.connect(signers[1]).burn(0);
    expect(burn).to.be.revertedWith("caller is not the owner");
  });
});
