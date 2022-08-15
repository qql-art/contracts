const { expect } = require("chai");

describe("MintPass", () => {
  let Clock;
  let MintPass;
  let TestTokenUriDelegate;

  let clock;

  function gwei(n) {
    return ethers.BigNumber.from("10").pow("9").mul(n);
  }

  before(async () => {
    Clock = await ethers.getContractFactory("Clock");
    MintPass = await ethers.getContractFactory("MintPass");
    TestTokenUriDelegate = await ethers.getContractFactory(
      "TestTokenUriDelegate"
    );

    clock = await Clock.deploy();
  });

  function basicSchedule(startTimestamp, startGwei) {
    return {
      startTimestamp,
      dropPeriodSeconds: 60,
      n1: 10,
      n2: 15,
      n3: 20,
      c1: 8,
      c2: 4,
      c3: 2,
      startGwei,
      dropGwei: 5,
      reserveGwei: 100,
    };
  }

  // Sets the time for the next block but does not mine it.
  async function setNextTimestamp(timestamp) {
    timestamp = Number(timestamp);
    await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  }
  async function mine() {
    await ethers.provider.send("evm_mine", []);
  }

  // Returns how much the Ether balance of the transaction's sender changed due
  // to the call, *not* counting the gas fee. Result is in wei.
  //
  // `tx` may be a transaction or a promise that resolves to a transaction.
  //
  // E.g., `diffEth(weth.connect(alice).deposit({ value: 7 }))` resolves to `-7`
  // regardless of what the gas price is.
  async function diffEth(tx) {
    tx = await tx;
    const rx = await tx.wait();
    const addr = tx.from;
    const before = await ethers.provider.getBalance(addr, rx.blockNumber - 1);
    const after = await ethers.provider.getBalance(addr, rx.blockNumber);
    const fee = rx.gasUsed.mul(rx.effectiveGasPrice);
    return after.add(fee).sub(before);
  }

  describe("auction mechanics", () => {
    it("supports reserving, purchasing, rebating, and withdrawing", async () => {
      const [owner, friend, alice, bob] = await ethers.getSigners();
      const mp = await MintPass.deploy(9);
      expect(await mp.maxCreated()).to.equal(9);
      expect(await mp.name()).to.equal("QQL Mint Pass");
      expect(await mp.symbol()).to.equal("QQL:MintPass");

      await mp.reserve(owner.address, 2);
      await mp.reserve(friend.address, 1);
      expect(await mp.endTimestamp()).to.equal(0);
      await expect(
        mp.connect(alice).purchase(2, { value: gwei(200) })
      ).to.be.revertedWith("MintPass: auction not started");

      expect(await mp.totalCreated()).to.equal(3);
      expect(await mp.totalSupply()).to.equal(3);

      const startTimestamp = +(await clock.timestamp()) + 10;
      await setNextTimestamp(startTimestamp);
      await mp.updateAuctionSchedule(basicSchedule(startTimestamp, 1000));
      function priceAfter(dt) {
        return mp.priceAt(startTimestamp + dt);
      }

      const netPayments = new Map();
      netPayments.set(alice.address, []);
      netPayments.set(bob.address, []);
      function recordPayment(signer, payment) {
        netPayments.get(signer.address).push(ethers.BigNumber.from(payment));
      }
      async function purchase(signer, n, value) {
        const tx = await mp.connect(signer).purchase(n, { value });
        recordPayment(signer, value);
        return tx;
      }
      function totalNetPayments(signer) {
        return netPayments
          .get(signer.address)
          .reduce((a, x) => a.add(x), ethers.constants.Zero);
      }

      await setNextTimestamp(startTimestamp + 5);
      // Purchase two, overpaying the current exact price a bit.
      await purchase(
        alice,
        2,
        await priceAfter(5).then((x) => x.mul(2).add(10))
      );

      await setNextTimestamp(startTimestamp + 65);
      // Try underpaying, which should fail.
      const priceAfter65 = await priceAfter(65);
      await expect(
        purchase(bob, 2, priceAfter65.mul(2).sub(1))
      ).to.be.revertedWith("MintPass: underpaid");
      await setNextTimestamp(startTimestamp + 66);
      expect(await priceAfter(66)).to.equal(priceAfter65); // not a drop boundary
      await purchase(bob, 2, priceAfter65.mul(2));

      await setNextTimestamp(startTimestamp + 125);
      // Pay exact change for one.
      await purchase(bob, 1, await priceAfter(125));

      await setNextTimestamp(startTimestamp + 184), await mine();
      // Claim an incremental rebate.
      {
        const aliceRebate1 = await priceAfter(184).then((now) =>
          totalNetPayments(alice).sub(now.mul(2))
        );
        expect(await mp.rebateAmount(alice.address)).to.equal(aliceRebate1);
        await setNextTimestamp(startTimestamp + 185);
        expect(await diffEth(mp.connect(alice).claimRebate())).to.equal(
          aliceRebate1
        );
        recordPayment(alice, aliceRebate1.mul(-1));
      }
      expect(await mp.rebateAmount(alice.address)).to.equal(gwei(0));
      // However, the owner can't withdraw proceeds until the auction is over,
      // since the proceeds may shrink as the clearing price goes down.
      await expect(
        mp.connect(owner).withdrawProceeds(owner.address)
      ).to.be.revertedWith("MintPass: auction not ended");

      await setNextTimestamp(startTimestamp + 60 * 60), await mine();
      expect(await mp.currentPrice()).to.equal(gwei(100)); // reserve price
      expect(await mp.endTimestamp()).to.equal(0);
      // Purchase the last piece at the reserve price, slightly overpaying.
      // This ends the auction.
      await setNextTimestamp(startTimestamp + 60 * 60 + 5);
      await purchase(alice, 1, gwei(101));
      expect(await mp.endTimestamp()).to.equal(startTimestamp + 60 * 60 + 5);

      expect(await mp.totalCreated()).to.equal(9);
      expect(await mp.totalSupply()).to.equal(9);
      const owners = await Promise.all(
        Array(9)
          .fill()
          .map((_, i) => mp.ownerOf(i + 1))
      );
      expect(owners).to.deep.equal([
        owner.address,
        owner.address,
        friend.address,
        alice.address,
        alice.address,
        bob.address,
        bob.address,
        bob.address,
        alice.address,
      ]);

      const costOfThree = gwei(300);

      {
        const aliceNetPayment = totalNetPayments(alice);
        const aliceRebate2 = aliceNetPayment.sub(costOfThree);
        expect(await mp.rebateAmount(alice.address)).to.equal(aliceRebate2);
        expect(await diffEth(mp.connect(alice).claimRebate())).to.equal(
          aliceRebate2
        );
      }

      {
        const bobNetPayment = totalNetPayments(bob);
        const bobRebate2 = bobNetPayment.sub(costOfThree);
        expect(await mp.rebateAmount(bob.address)).to.equal(bobRebate2);
        expect(await mp.rebateAmount(bob.address)).to.equal(bobRebate2);
        expect(await diffEth(mp.connect(bob).claimRebate())).to.equal(
          bobRebate2
        );
      }

      // The owner and friend get no rebate since their passes were free.
      expect(await mp.rebateAmount(owner.address)).to.equal(0);
      expect(await mp.rebateAmount(friend.address)).to.equal(0);
      expect(await diffEth(mp.connect(owner).claimRebate())).to.equal(0);
      expect(await diffEth(mp.connect(friend).claimRebate())).to.equal(0);

      // Alice and Bob get nothing if they try again.
      expect(await mp.rebateAmount(alice.address)).to.equal(0);
      expect(await mp.rebateAmount(bob.address)).to.equal(0);
      expect(await diffEth(mp.connect(alice).claimRebate())).to.equal(0);
      expect(await diffEth(mp.connect(bob).claimRebate())).to.equal(0);

      expect(
        await diffEth(mp.connect(owner).withdrawProceeds(owner.address))
      ).to.equal(gwei(100 * 6));
      await expect(
        mp.connect(owner).withdrawProceeds(owner.address)
      ).to.be.revertedWith("MintPass: already withdrawn");

      expect(await ethers.provider.getBalance(mp.address)).to.equal(0);

      // No one can purchase or reserve any more passes.
      await expect(
        mp.connect(alice).purchase(1, { value: gwei(99999) })
      ).to.be.revertedWith("MintPass: minted out");
      await expect(
        mp.connect(owner).reserve(owner.address, 1)
      ).to.be.revertedWith("MintPass: minted out");
      await expect(
        mp.connect(owner).reserve(owner.address, 0)
      ).to.be.revertedWith("MintPass: count is zero");
    });

    it("properly implements a realistic schedule", async () => {
      const mp = await MintPass.deploy(1);
      const startTimestamp = +(await clock.timestamp()) + 10;
      await setNextTimestamp(startTimestamp);
      await mp.updateAuctionSchedule({
        startTimestamp,
        dropPeriodSeconds: 60,
        n1: 10,
        n2: 15,
        n3: 20,
        c1: 8,
        c2: 4,
        c3: 2,
        startGwei: 50e9, // 50 ETH starting price
        dropGwei: 0.25e9, // drop 2 ETH/minute, then 1, then 0.5, then 0.25
        reserveGwei: 5e9, // 1 ETH reserve price
      });

      async function checkPriceSeconds({ label, seconds, expected }) {
        const actual = await mp.priceAt(startTimestamp + seconds);
        expect({ label, price: String(actual) }).to.deep.equal({
          label,
          price: String(ethers.BigNumber.from(expected)),
        });
      }
      async function checkPrice({ minutes, expected }) {
        const secondsExactly = minutes * 60;
        await checkPriceSeconds({
          label: `exactly ${minutes} minutes`,
          seconds: secondsExactly,
          expected,
        });
        await checkPriceSeconds({
          label: `just after ${minutes} minutes`,
          seconds: secondsExactly + 5,
          expected,
        });
      }

      await checkPrice({ minutes: -1, expected: ethers.constants.MaxUint256 });
      await checkPrice({ minutes: 0, expected: gwei(50e9) });
      await checkPrice({ minutes: 1, expected: gwei(48e9) });
      await checkPrice({ minutes: 2, expected: gwei(46e9) });
      // ...
      await checkPrice({ minutes: 9, expected: gwei(32e9) });
      await checkPrice({ minutes: 10, expected: gwei(30e9) });
      await checkPrice({ minutes: 11, expected: gwei(29e9) });
      await checkPrice({ minutes: 12, expected: gwei(28e9) });
      // ...
      await checkPrice({ minutes: 24, expected: gwei(16.0e9) });
      await checkPrice({ minutes: 25, expected: gwei(15.0e9) });
      await checkPrice({ minutes: 26, expected: gwei(14.5e9) });
      await checkPrice({ minutes: 27, expected: gwei(14.0e9) });
      // ...
      await checkPrice({ minutes: 44, expected: gwei(5.5e9) });
      await checkPrice({ minutes: 45, expected: gwei(5.0e9) });
      await checkPrice({ minutes: 46, expected: gwei(5.0e9) }); // hit reserve
      await checkPrice({ minutes: 47, expected: gwei(5.0e9) });
      // ...
      expect(await mp.priceAt(ethers.constants.MaxUint256)).to.equal(gwei(5e9));
    });

    it("fails cleanly if a collector tries to buy more than 2^256 wei worth of passes", async () => {
      const mp = await MintPass.deploy(1);
      const startTimestamp = +(await clock.timestamp()) + 10;
      await setNextTimestamp(startTimestamp);
      await mp.updateAuctionSchedule(basicSchedule(startTimestamp, 100));

      await expect(
        mp.purchase(ethers.constants.MaxUint256.div(2), { value: 1 })
      ).to.be.revertedWith("MintPass: underpaid");
    });

    it("permits updating the schedule before or during the auction", async () => {
      const mp = await MintPass.deploy(1);

      const t0 = +(await clock.timestamp());

      const initialStart = t0 + 10;
      await setNextTimestamp(initialStart - 2);
      await mp.updateAuctionSchedule(basicSchedule(initialStart, 1000));

      // Still before start.
      expect(await mp.currentPrice()).to.equal(ethers.constants.MaxUint256);

      await setNextTimestamp(initialStart), await mine();
      expect(await mp.currentPrice()).to.equal(gwei(1000));

      await setNextTimestamp(initialStart + 60), await mine();
      expect(await mp.currentPrice()).to.equal(gwei(960));

      // Move the start time back, which decreases the current price.
      await mp.updateAuctionSchedule(basicSchedule(initialStart - 60, 1000));
      expect(await mp.currentPrice()).to.equal(gwei(920));

      // Move the start time forward but drop the start price.
      await setNextTimestamp(initialStart + 120), await mine();
      await mp.updateAuctionSchedule(basicSchedule(initialStart + 120, 500));
      expect(await mp.currentPrice()).to.equal(gwei(500));
    });

    it("prevents updating the schedule if the price would increase", async () => {
      const mp = await MintPass.deploy(1);
      const startTimestamp = +(await clock.timestamp());
      const oldSchedule = basicSchedule(startTimestamp, 100);
      await mp.updateAuctionSchedule(oldSchedule);
      const newSchedule = basicSchedule(startTimestamp, 101);
      await expect(mp.updateAuctionSchedule(newSchedule)).to.be.revertedWith(
        "MintPass: price would increase"
      );
    });

    it("prevents updating the schedule if the auction is over", async () => {
      const mp = await MintPass.deploy(1);
      const startTimestamp = +(await clock.timestamp());
      const oldSchedule = basicSchedule(startTimestamp, 100);
      await mp.updateAuctionSchedule(oldSchedule);
      await mp.purchase(1, { value: gwei(100) });
      const newSchedule = basicSchedule(startTimestamp, 50);
      await expect(mp.updateAuctionSchedule(newSchedule)).to.be.revertedWith(
        "MintPass: auction ended"
      );
    });

    it("prevents updating the schedule if it ended without beginning", async () => {
      const [owner] = await ethers.getSigners();
      const mp = await MintPass.deploy(1);
      await mp.reserve(owner.address, 1);
      const startTimestamp = +(await clock.timestamp());
      const schedule = basicSchedule(startTimestamp, 100);
      await expect(mp.updateAuctionSchedule(schedule)).to.be.revertedWith(
        "MintPass: auction ended"
      );
    });
  });

  describe("burner role", () => {
    it("can be set by the owner", async () => {
      const [owner, burner] = await ethers.getSigners();
      const mp = await MintPass.deploy(1);
      await mp.setBurner(burner.address);
      expect(await mp.burner()).to.equal(burner.address);
    });

    it("can't be set by unrelated accounts", async () => {
      const [owner, burner] = await ethers.getSigners();
      const mp = await MintPass.deploy(1);
      await expect(
        mp.connect(burner).setBurner(burner.address)
      ).to.be.revertedWith("Ownable:");
    });

    it("permits the burner to burn tokens", async () => {
      const [owner, holder, burner] = await ethers.getSigners();
      const mp = await MintPass.deploy(3);
      await mp.setBurner(burner.address);
      await mp.reserve(holder.address, 3);

      expect(await mp.totalCreated()).to.equal(3);
      expect(await mp.totalSupply()).to.equal(3);

      await expect(mp.connect(burner).burn(2))
        .to.emit(mp, "Transfer")
        .withArgs(holder.address, ethers.constants.AddressZero, 2);

      expect(await mp.totalCreated()).to.equal(3);
      expect(await mp.totalSupply()).to.equal(2);
    });

    it("doesn't permit anyone else to burn tokens", async () => {
      const [owner, holder, burner] = await ethers.getSigners();
      const mp = await MintPass.deploy(3);
      await mp.setBurner(burner.address);
      await mp.reserve(holder.address, 1);
      await expect(mp.connect(holder).burn(1)).to.be.revertedWith(
        "MintPass: unauthorized"
      );
    });
  });

  describe("isApprovedOrOwner", () => {
    it("authorizes the owner of a token", async () => {
      const [owner, holder] = await ethers.getSigners();
      const mp = await MintPass.deploy(1);
      await mp.reserve(holder.address, 1);
      expect(await mp.isApprovedOrOwner(holder.address, 1)).to.be.true;
    });
    it("authorizes the approved operator of a token", async () => {
      const [owner, holder, operator] = await ethers.getSigners();
      const mp = await MintPass.deploy(1);
      await mp.reserve(holder.address, 1);
      await mp.connect(holder).approve(operator.address, 1);
      expect(await mp.isApprovedOrOwner(operator.address, 1)).to.be.true;
    });
    it("authorizes a token holder's globally approved operator", async () => {
      const [owner, holder, operator] = await ethers.getSigners();
      const mp = await MintPass.deploy(1);
      await mp.connect(holder).setApprovalForAll(operator.address, true);
      await mp.reserve(holder.address, 1);
      expect(await mp.isApprovedOrOwner(operator.address, 1)).to.be.true;
    });
    it("doesn't authorize anyone else", async () => {
      const [owner, holder, nonOperator] = await ethers.getSigners();
      const mp = await MintPass.deploy(1);
      await mp.reserve(holder.address, 1);
      expect(await mp.isApprovedOrOwner(nonOperator.address, 1)).to.be.false;
    });
  });

  describe("tokenURI", () => {
    it("delegate can be set by the owner", async () => {
      const mp = await MintPass.deploy(1);
      const uriDelegate = await TestTokenUriDelegate.deploy();
      await mp.setTokenUriDelegate(uriDelegate.address);
      expect(await mp.tokenUriDelegate()).to.equal(uriDelegate.address);
    });
    it("delegate can't be set by non-owners", async () => {
      const [owner, notOwner] = await ethers.getSigners();
      const mp = await MintPass.deploy(1);
      const uriDelegate = await TestTokenUriDelegate.deploy();
      await expect(
        mp.connect(notOwner).setTokenUriDelegate(uriDelegate.address)
      ).to.be.revertedWith("Ownable:");
      expect(await mp.tokenUriDelegate()).to.equal(
        ethers.constants.AddressZero
      );
    });

    it("works when set or unset, with extant and non-existent tokens", async () => {
      const [owner, holder] = await ethers.getSigners();
      const mp = await MintPass.deploy(2);
      await mp.reserve(holder.address, 1);

      expect(await mp.tokenURI(1)).to.equal("");
      await expect(mp.tokenURI(2)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );

      const uriDelegate = await TestTokenUriDelegate.deploy();
      await mp.setTokenUriDelegate(uriDelegate.address);

      expect(await mp.tokenURI(1)).to.equal(
        `data:text/plain,${mp.address.toLowerCase()}%20%231`
      );
      await expect(mp.tokenURI(2)).to.be.revertedWith(
        "ERC721: invalid token ID"
      );
    });
  });
});
