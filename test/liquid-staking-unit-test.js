const { ethers } = require("hardhat");
const { expect } = require("chai");
const { upgrades } = require("hardhat");

async function sealEpoch(sfc, duration, _validatorsMetrics = undefined) {
    let validatorsMetrics = _validatorsMetrics;
    const validatorIDs = (await sfc.lastValidatorID()).toNumber();

    if (validatorsMetrics === undefined) {
        validatorsMetrics = {};
        for (let i = 0; i < validatorIDs; i++) {
            validatorsMetrics[i] = {
                offlineTime: ethers.BigNumber.from(0),
                offlineBlocks: ethers.BigNumber.from(0),
                uptime: duration,
                originatedTxsFee: ethers.utils.parseEther('0'),
            };
        }
    }
    // unpack validator metrics
    const allValidators = [];
    const offlineTimes = [];
    const offlineBlocks = [];
    const uptimes = [];
    const originatedTxsFees = [];
    for (let i = 0; i < validatorIDs; i++) {
        allValidators.push(i + 1);
        offlineTimes.push(validatorsMetrics[i].offlineTime);
        offlineBlocks.push(validatorsMetrics[i].offlineBlocks);
        uptimes.push(validatorsMetrics[i].uptime);
        originatedTxsFees.push(validatorsMetrics[i].originatedTxsFee);
    }

    await sfc.advanceTime(duration);
    await sfc.sealEpoch(offlineTimes, offlineBlocks, uptimes, originatedTxsFees, 0);
    await sfc.sealEpochValidators(allValidators);
}

describe("Liquid Staking with SFC", function() {
    const Rate = 30;
    const StakeRatio = 90;
    const RewardRate = 75;
    let ValidatorId;

    const pubkey = '0x00a2941866e485442aa6b17d67d77f8a6c4580bb556894cc1618473eff1e18203d8cce50b563cf4c75e408886079b8f067069442ed52e2ac9e556baa3f8fcc525f';
    const amount = ethers.utils.parseEther("1");

    let LiquidStaking;
    let liquidStaking;

    let SFC;
    let sfc;

    let nodeIRaw;
    let evmWriter;
    let nodeI;
    let sfcLib;
    let initializer;
    let consts;

    let owner;
    let badActor;
    let alice;
    let bob;

    let validator1;
    let validator2;
    let validator3;

    before(async function() {
        console.log(Rate.toString());
        console.log(StakeRatio.toString());

        [owner, badActor, alice, bob, validator1, validator2, validator3] = await ethers.getSigners();
        
        console.log("Owner:", owner.address);
        console.log("Bad actor:", badActor.address);
        console.log("Alice:", alice.address);
        console.log("Bob:", bob.address);

        console.log("validator 1:", validator1.address);
        console.log("validator 2:", validator2.address);
        console.log("validator 3:", validator3.address);

        LiquidStaking = await ethers.getContractFactory("LiquidStaking");
    });

    beforeEach(async function()  {
        SFC = await ethers.getContractFactory("UnitTestSFC");
        sfc = await ethers.getContractAt("SFCUnitTestI", (await SFC.deploy()).address);
        await sfc.enableNonNodeCalls();

        const NodeDriver = await ethers.getContractFactory("NodeDriver");
        nodeIRaw = await NodeDriver.deploy();

        const StubEvmWriter = await ethers.getContractFactory("StubEvmWriter");
        evmWriter = await StubEvmWriter.deploy();
    
        const NodeDriverAuth = await ethers.getContractFactory("NodeDriverAuth");
        nodeI = await NodeDriverAuth.deploy();

        const UnitTestSFCLib = await ethers.getContractFactory("SFCTest");
        sfcLib = await UnitTestSFCLib.deploy();

        const NetworkInitializer = await ethers.getContractFactory("UnitTestNetworkInitializer");
        initializer = await NetworkInitializer.deploy();

        await initializer.initializeAll(0, 0, sfc.address, sfcLib.address, nodeI.address, nodeIRaw.address, evmWriter.address, owner.address);

        const ConstantsManager = await ethers.getContractFactory("UnitTestConstantsManager");
        consts = ConstantsManager.attach(await sfc.constsAddress());
        await sfc.rebaseTime();

        await sfc.connect(validator1).createValidator(pubkey, { value: ethers.utils.parseEther("10") });
        ValidatorId = await sfc.lastValidatorID();

        liquidStaking = await upgrades.deployProxy(LiquidStaking, [Rate, StakeRatio, RewardRate, ValidatorId, sfc.address], { initializer: 'initialize', kind: 'uups' });
        await liquidStaking.deployed();
    });

    it("Should create new validators", async function() {
        await sfc.connect(validator2).createValidator(pubkey, { value: ethers.utils.parseEther("10") });
        expect(await sfc.lastValidatorID()).to.equal(2);

        await sfc.connect(validator3).createValidator(pubkey, { value: ethers.utils.parseEther("10") });
        expect(await sfc.lastValidatorID()).to.equal(3);
    });

    it('Returns current Epoch', async () => {
        expect((await sfc.currentEpoch()).toString()).to.equals('1');
    });

    it('Returns minimum amount to stake for a Validator', async () => {
        expect((await consts.minSelfStake()).toString()).to.equals('317500000000000000');
    });

    it('Returns the maximum ratio of delegations a validator can have', async () => {
        expect((await consts.maxDelegatedRatio()).toString()).to.equals('16000000000000000000');
    });

    it("Should allow to delegate", async function() {
        await sfc.connect(bob).delegate(ValidatorId, { value: ethers.utils.parseEther('0.9') });
        expect((await sfc.getStake(bob.address, ValidatorId)).toString()).to.equals(ethers.utils.parseEther('0.9'));
    });

    it("Should return SFC address", async function() {
        expect(await liquidStaking.sfc()).to.equal(sfc.address);
    });
    
    it("Should allow to stake", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});

        const userStake = await liquidStaking.userStake(alice.address);
        const stTQFAmount = (ethers.utils.parseEther("1")).mul(Rate).div(100);

        expect(userStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(userStake.stakedAmount).to.equal(amount);
        expect(userStake.rewards).to.equal(0);
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount);
    });

    it("Should allow staking again and calculate the reward correctly", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});

        let aliceStake = await liquidStaking.userStake(alice.address);

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount);
        expect(aliceStake.rewards).to.equal(0);

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        await liquidStaking.connect(alice).stake({ value: ethers.utils.parseEther("1")});
        aliceStake = await liquidStaking.userStake(alice.address);

        let expectedeAmountInStake = amount.mul(2);
        const stahedRewards = await sfc.rewardsStash(liquidStaking.address, ValidatorId);
        
        expect(aliceStake.stakedAmount).to.equal(expectedeAmountInStake);
        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.rewards).to.equal(stahedRewards);
    });

    it("Should allow different people to stake and calculate the reward correctly", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});

        let aliceStake = await liquidStaking.userStake(alice.address);

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount);
        expect(aliceStake.rewards).to.equal(0);

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        await liquidStaking.connect(bob).stake({ value: ethers.utils.parseEther("1")});

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: ethers.utils.parseEther("1")});
        await liquidStaking.connect(bob).stake({ value: ethers.utils.parseEther("1")});

        const stahedRewards = await sfc.rewardsStash(liquidStaking.address, ValidatorId);
        aliceStake = await liquidStaking.userStake(alice.address);
        let bobStake = await liquidStaking.userStake(bob.address);
        
        expect(bobStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(bobStake.stakedAmount).to.equal(amount.mul(2));
        expect(bobStake.rewards).to.approximately(stahedRewards.sub(aliceStake.rewards), ethers.BigNumber.from(1));

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount.mul(2));
        expect(aliceStake.rewards).to.approximately(stahedRewards.sub(bobStake.rewards), ethers.BigNumber.from(1));
    });

    it("Should allow to withdraw, case 1: the entire balance", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});

        let aliceStake = await liquidStaking.userStake(alice.address);
        const stTQFAmount = (ethers.utils.parseEther("1")).mul(Rate).div(100);

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount);
        expect(aliceStake.rewards).to.equal(0);
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount);

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        const stakedRate = await sfc.getEpochAccumulatedRewardPerToken(aliceStake.lastStakeEpoch, ValidatorId);
        const currentRate = await sfc.getEpochAccumulatedRewardPerToken(await sfc.currentSealedEpoch(), ValidatorId);
        const unlockedRewardRatio = await consts.unlockedRewardRatio();

        const expectedRewards = ((currentRate.sub(stakedRate)).mul(ethers.utils.parseEther("0.9")).div(ethers.utils.parseEther("1"))).mul(unlockedRewardRatio).div(ethers.utils.parseEther("1"));
        const rewardsToTransfer = expectedRewards.mul(RewardRate).div(100);

        await alice.sendTransaction({
            to: liquidStaking.address,
            value: ethers.utils.parseEther("10")
        });

        const wrIds = [];
        const tx = await liquidStaking.connect(alice).withdraw(stTQFAmount, wrIds);
        aliceStake = await liquidStaking.userStake(alice.address);
        
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(0);
        expect(aliceStake.rewards).to.equal(0);
        expect(aliceStake.stakedAmount).to.equal(0);
        expect(tx).to.emit(liquidStaking, "Withdraw").withArgs(alice.address, ethers.utils.parseEther("1").add(rewardsToTransfer));
    });

    it("Should allow to withdraw, case 2: the half of balance", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});

        let aliceStake = await liquidStaking.userStake(alice.address);
        const stTQFAmount = (ethers.utils.parseEther("1")).mul(Rate).div(100);

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount);
        expect(aliceStake.rewards).to.equal(0);
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount);

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        const stakedRate = await sfc.getEpochAccumulatedRewardPerToken(aliceStake.lastStakeEpoch, ValidatorId);
        const currentRate = await sfc.getEpochAccumulatedRewardPerToken(await sfc.currentSealedEpoch(), ValidatorId);
        const unlockedRewardRatio = await consts.unlockedRewardRatio();

        const expectedRewards = ((currentRate.sub(stakedRate)).mul(ethers.utils.parseEther("0.9")).div(ethers.utils.parseEther("1"))).mul(unlockedRewardRatio).div(ethers.utils.parseEther("1"));
        const rewardForShare = expectedRewards.div(2);
        const rewardsToTransfer = rewardForShare.mul(RewardRate).div(100);

        const wrIds = [];
        const amountReceived = await liquidStaking.connect(alice).callStatic.withdraw(stTQFAmount.div(2), wrIds)
        const amountBurned = amountReceived.mul(Rate).div(100);
        const tx = await liquidStaking.connect(alice).withdraw(stTQFAmount.div(2), wrIds);

        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount.sub(amountBurned));
        expect(tx).to.emit(liquidStaking, "Withdraw").withArgs(alice.address, ethers.utils.parseEther("0.1").add(rewardsToTransfer));
    });
    
    it("Should allow to withdraw, case 2: 10% of balance", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});
        const balanceAfterStaking = await alice.provider.getBalance(alice.address);

        let aliceStake = await liquidStaking.userStake(alice.address);
        const stTQFAmount = (ethers.utils.parseEther("1")).mul(Rate).div(100);

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount);
        expect(aliceStake.rewards).to.equal(0);
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount);

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        const stakedRate = await sfc.getEpochAccumulatedRewardPerToken(aliceStake.lastStakeEpoch, ValidatorId);
        const currentRate = await sfc.getEpochAccumulatedRewardPerToken(await sfc.currentSealedEpoch(), ValidatorId);
        const unlockedRewardRatio = await consts.unlockedRewardRatio();

        const share = 10;
        const expectedRewards = ((currentRate.sub(stakedRate)).mul(ethers.utils.parseEther("0.9")).div(ethers.utils.parseEther("1"))).mul(unlockedRewardRatio).div(ethers.utils.parseEther("1"));
        const rewardForShare = expectedRewards.mul(share).div(100);
        const rewardsToTransfer = rewardForShare.mul(RewardRate).div(100);

        const wrIds = [];
        const tx = await liquidStaking.connect(alice).withdraw(stTQFAmount.mul(share).div(100), wrIds);
        const balanceAfterWithdraw = await alice.provider.getBalance(alice.address);
        const balanceDiff = balanceAfterWithdraw.sub(balanceAfterStaking);

        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount.mul(100 - share).div(100));
        expect(tx).to.emit(liquidStaking, "Withdraw").withArgs(alice.address, ethers.utils.parseEther("0.1").add(rewardsToTransfer));
        expect(balanceDiff).to.approximately(ethers.utils.parseEther("0.1").add(rewardsToTransfer), ethers.utils.parseEther("0.005"));
    });

    it ("Should transfer the entire balance and undelegate stake if there is no enough funds to cover withdraw request", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});

        let aliceStake = await liquidStaking.userStake(alice.address);
        const stTQFAmount = (ethers.utils.parseEther("1")).mul(Rate).div(100);

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount);
        expect(aliceStake.rewards).to.equal(0);
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount);
        expect(await alice.provider.getBalance(liquidStaking.address)).to.equal(ethers.utils.parseEther('0.1'));

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        const stakedRate = await sfc.getEpochAccumulatedRewardPerToken(aliceStake.lastStakeEpoch, ValidatorId);
        const currentRate = await sfc.getEpochAccumulatedRewardPerToken(await sfc.currentSealedEpoch(), ValidatorId);
        const unlockedRewardRatio = await consts.unlockedRewardRatio();

        const expectedRewards = ((currentRate.sub(stakedRate)).mul(ethers.utils.parseEther("0.9")).div(ethers.utils.parseEther("1"))).mul(unlockedRewardRatio).div(ethers.utils.parseEther("1"));
        const rewardsToTransfer = expectedRewards.mul(RewardRate).div(100);

        const wrIds = [];
        const amountReceived = await liquidStaking.connect(alice).callStatic.withdraw(stTQFAmount, wrIds)
        const amountBurned = amountReceived.mul(Rate).div(100);
        const tx = await liquidStaking.connect(alice).withdraw(stTQFAmount, wrIds);
        aliceStake = await liquidStaking.userStake(alice.address);
        
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount.sub(amountBurned));
        expect(aliceStake.rewards).to.equal(0);
        expect(aliceStake.stakedAmount).to.equal(amount.sub(amountReceived));
        expect(tx).to.emit(liquidStaking, "Withdraw").withArgs(alice.address, ethers.utils.parseEther("1").add(rewardsToTransfer));
        expect(tx).to.emit(liquidStaking, "Unstake").withArgs(ValidatorId, 0, ethers.utils.parseEther("1").add(rewardsToTransfer).sub(ethers.utils.parseEther('0.1')));

        const withdrawRequest = await liquidStaking.withdrawals(ValidatorId, 0);
        expect(withdrawRequest.amount).to.equal(ethers.utils.parseEther("1").add(rewardsToTransfer).sub(expectedRewards.add(ethers.utils.parseEther("0.1"))));
    });

    it("Should update user stake info after transfer", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(bob).stake({ value: ethers.utils.parseEther("1")});
       
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        const stTQFAmount = (ethers.utils.parseEther("1")).mul(Rate).div(100);

        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount);
        expect(await liquidStaking.balanceOf(bob.address)).to.equal(stTQFAmount);

        const bobStakeBefore = await liquidStaking.userStake(bob.address);
        const aliceStakeBefore = await liquidStaking.userStake(alice.address);

        const share = 70; // %
        const amountToTransfer = stTQFAmount.mul(share).div(100); // 70% of balanace
        
        await liquidStaking.connect(alice).transfer(bob.address, amountToTransfer);

        const bobStakeAfter = await liquidStaking.userStake(bob.address);
        const aliceStakeAfter = await liquidStaking.userStake(alice.address);

        expect(bobStakeAfter.stakedAmount).to.equal(bobStakeBefore.stakedAmount.add(aliceStakeBefore.stakedAmount.mul(share).div(100)));
        expect(aliceStakeAfter.stakedAmount).to.equal(aliceStakeBefore.stakedAmount.sub(aliceStakeBefore.stakedAmount.mul(share).div(100)));
    });

    it("Should allow to return amount available to the user for withdrawal", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await liquidStaking.connect(alice).stake({ value: amount});

        let aliceStake = await liquidStaking.userStake(alice.address);
        const stTQFAmount = (ethers.utils.parseEther("1")).mul(Rate).div(100);

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount);
        expect(aliceStake.rewards).to.equal(0);
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount);

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        const stakedRate = await sfc.getEpochAccumulatedRewardPerToken(aliceStake.lastStakeEpoch, ValidatorId);
        const currentRate = await sfc.getEpochAccumulatedRewardPerToken(await sfc.currentSealedEpoch(), ValidatorId);
        const unlockedRewardRatio = await consts.unlockedRewardRatio();

        const expectedRewards = ((currentRate.sub(stakedRate)).mul(ethers.utils.parseEther("0.9")).div(ethers.utils.parseEther("1"))).mul(unlockedRewardRatio).div(ethers.utils.parseEther("1"));
        const tx = await liquidStaking.connect(alice).callStatic.getAvailableWithdrowalAmount();

        expect(tx.unstakedCoins).to.equal(ethers.utils.parseEther("0.1"));
        expect(tx.userStakedCoins).to.equal(amount);
        expect(tx.userRewards).to.equal(expectedRewards);
    });

    it("Should not allow to create as many withdraw requests as you want", async function() {
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        await liquidStaking.connect(alice).stake({ value: amount});
        await liquidStaking.connect(bob).stake({ value: ethers.utils.parseEther("1")});

        const stTQFAmount = (ethers.utils.parseEther("1")).mul(Rate).div(100);
        expect(await ethers.provider.getBalance(liquidStaking.address)).to.equal(ethers.utils.parseEther("0.2"));
        
        let aliceStake = await liquidStaking.userStake(alice.address);
        let bobStake = await liquidStaking.userStake(bob.address);

        expect(aliceStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(aliceStake.stakedAmount).to.equal(amount);
        expect(aliceStake.rewards).to.equal(0);
        expect(await liquidStaking.balanceOf(alice.address)).to.equal(stTQFAmount);

        expect(bobStake.lastStakeEpoch).to.equal(await sfc.currentSealedEpoch());
        expect(bobStake.stakedAmount).to.equal(amount);
        expect(bobStake.rewards).to.equal(0);
        expect(await liquidStaking.balanceOf(bob.address)).to.equal(stTQFAmount);

        await sealEpoch(sfc, ethers.BigNumber.from(1));
        await sealEpoch(sfc, ethers.BigNumber.from(1));

        const wrIds = [];
        let bobStTQFBalance = await liquidStaking.callStatic.balanceOf(bob.address);
        await liquidStaking.connect(bob).withdraw(bobStTQFBalance, wrIds);

        const bobStTQFBalanceAfterWithdrawal = await liquidStaking.callStatic.balanceOf(bob.address);
        expect(bobStTQFBalanceAfterWithdrawal).to.be.lessThan(bobStTQFBalance);

        await expect(liquidStaking.connect(bob).withdraw(bobStTQFBalanceAfterWithdrawal, wrIds)).to.be.revertedWith("withdrawal request limit reached");
    });
});