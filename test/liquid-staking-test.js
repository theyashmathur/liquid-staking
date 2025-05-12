const { ethers } = require("hardhat");
const { expect } = require("chai");
const { upgrades } = require("hardhat");

describe("Liquid Staking test", function() {
    const Rate = ethers.utils.parseUnits("30", 18);
    const StakeRatio = ethers.utils.parseUnits("90", 18);
    const RewardRate = 75;
    const ValidatorId = 1;
    const SFCAddress = "0xFC00FACE00000000000000000000000000000000";

    let LiquidStaking;
    let liquidStaking;

    let owner;
    let badActor;
    let alice;
    let bob;

    before(async function() {
        console.log(Rate.toString());
        console.log(StakeRatio.toString());

        [owner, badActor, alice, bob] = await ethers.getSigners();
        
        console.log("Owner:", owner.address);
        console.log("Bad actor:", badActor.address);
        console.log("Alice:", alice.address);
        console.log("Bob:", bob.address);

        LiquidStaking = await ethers.getContractFactory("LiquidStaking");
    });

    beforeEach(async function()  {
        liquidStaking = await upgrades.deployProxy(LiquidStaking, [Rate, StakeRatio, RewardRate, ValidatorId, SFCAddress], { initializer: 'initialize', kind: 'uups' });
        await liquidStaking.deployed();
    });

    it("Should return all public variables", async function() {
        expect(await liquidStaking.sfc()).to.equal(SFCAddress);
        expect(await liquidStaking.rate()).to.equal(Rate);
        expect(await liquidStaking.stakeRatio()).to.equal(StakeRatio);
        expect(await liquidStaking.validatorId()).to.equal(ValidatorId);
    });

    it("Should allow admin to set rate", async function() {
        const NewRate = ethers.utils.parseUnits("20", 18);
        const tx = await liquidStaking.setRate(NewRate);

        expect(await liquidStaking.rate()).to.equal(NewRate);
        expect(tx).to.emit(liquidStaking, "NewRate").withArgs(
            Rate,
            NewRate
        );
    });

    it("Should not allow to non-admin set rate", async function() {
        const NewRate = ethers.utils.parseUnits("20", 18);

        await expect(liquidStaking.connect(badActor).setRate(NewRate)).to.be.reverted;
    });

    it("Should not allow to set a non-positive rate", async function() {
        await expect(liquidStaking.setRate(0)).to.be.revertedWith("Rate must be greater than 0");
    });

    it("Should allow admin to set stake ratio", async function() {
        const NewStakeRatio = ethers.utils.parseUnits("50", 18);
        const tx = await liquidStaking.setStakeRatio(NewStakeRatio);

        expect(await liquidStaking.stakeRatio()).to.equal(NewStakeRatio);
        expect(tx).to.emit(liquidStaking, "NewStakeRatio").withArgs(
            StakeRatio,
            NewStakeRatio
        );
    });

    it("Should not allow non-admin to set stake ratio", async function() {
        const NewStakeRatio = ethers.utils.parseUnits("50", 18);

        await expect(liquidStaking.connect(badActor).setStakeRatio(NewStakeRatio)).to.be.reverted;
    });

    it("Should not allow to set a non-positive lockup ratio", async function() {
        await expect(liquidStaking.setStakeRatio(0)).to.be.revertedWith("Lockup Ratio must be greater then 0");
    });

    it("Should allow admin to set new validator", async function() {
        const NewValidatorId = 2;
        const tx = await liquidStaking.setValidatorId(NewValidatorId);

        expect(await liquidStaking.validatorId()).to.equal(NewValidatorId);
        expect(tx).to.emit(liquidStaking, "NewValidatorId").withArgs(
            ValidatorId,
            NewValidatorId
        );
    });

    it("Should not allow non-admin to set new validator", async function() {
        const NewValidatorId = 2;

        await expect(liquidStaking.connect(badActor).setValidatorId(NewValidatorId)).to.be.reverted;
    });

    it("Should not allow to set new validator if the new validator is the same as the old one", async function() {
        const NewValidatorId = 1;

        await expect(liquidStaking.setValidatorId(NewValidatorId)).to.be.revertedWith(
            "New validator must be different from the old one"
        );
    });

    it("Should not allow to set an inactive validator", async function() {
        const NewValidatorId = 9999;

        await expect(liquidStaking.setValidatorId(NewValidatorId)).to.be.revertedWith("New validator is inactive");
    });

    it("Should emit an event if it failed to stash the rewards", async function() {
        const NewValidatorId = 2;
        const tx = await liquidStaking.setValidatorId(NewValidatorId);

        expect(await liquidStaking.validatorId()).to.equal(NewValidatorId);
        expect(tx).to.emit(liquidStaking, "NewValidatorId").withArgs(
            ValidatorId,
            NewValidatorId
        );
        expect(tx).to.emit(liquidStaking, "FailedToStash").withArgs(ValidatorId);
    });

    it("Should allow to stake", async function() {
        await liquidStaking.connect(alice).stake({ value: ethers.utils.parseEther("1")});

        expect(await liquidStaking.userStake(alice.address)).to.equal({
            lastStakeEpoch: await sfc.currentEpoch(),
            stakedAmount: ethers.utils.parseEther("1"),
            rewards: 0
        });
    });
});