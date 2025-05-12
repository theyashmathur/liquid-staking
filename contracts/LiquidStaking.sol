// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/SafeMathUpgradeable.sol";
import "hardhat/console.sol";

interface SFC {
    struct Validator {
        uint256 status;
        uint256 deactivatedTime;
        uint256 deactivatedEpoch;

        uint256 receivedStake;
        uint256 createdEpoch;
        uint256 createdTime;

        address auth;
    }

    struct WithdrawalRequest {
        uint256 epoch;
        uint256 time;

        uint256 amount;
    }

    function getEpochAccumulatedRewardPerToken(uint256 epoch, uint256 validatorID) external view returns (uint256);
    function getValidator(uint256 toValidatorId) external returns (Validator memory);
    function getUnlockedStake(address delegator, uint256 toValidatorID) external view returns (uint256);
    function constsAddress() external view returns (address);
    function getWithdrawalRequest(address delegator, uint256 toValidatorId, uint256 wrId) external returns (WithdrawalRequest memory);

    function doNothing() external payable;
    function delegate(uint256 toValidatorID) external payable;
    function stashRewards(address delegator, uint256 toValidatorId) external;
    function rewardsStash(address delegator, uint256 toValidatorId) external returns (uint256);
    function claimRewards(uint256 toValidatorId) external;
    function undelegate(uint256 toValidatorID, uint256 wrID, uint256 amount) external;
    function withdraw(uint256 toValidatorID, uint256 wrID) external;
    function currentEpoch() external view returns (uint256);
    function currentSealedEpoch() external view returns (uint256);
}

interface ConstantsManager {
    function withdrawalPeriodTime() external returns (uint256);
    function unlockedRewardRatio() external returns (uint256);
}

contract LiquidStaking is AccessControlUpgradeable, UUPSUpgradeable, ERC20Upgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    using SafeMathUpgradeable for uint256;

    struct WithdrawRequest {
        uint256 amount;
        uint256 time;
        bool withdrawn;
    }

    struct StakeRecord {
        uint256 lastStakeEpoch;
        uint256 stakedAmount;
        uint256 rewards;
    }

    uint256 public rate; // % of token to be minted 
    uint256 public stakeRatio; // 90%
    uint256 public rewardRate; // % of rewards that will be sent to the user
    uint256 public validatorId;

    SFC public sfc;
    ConstantsManager internal c;

    mapping(uint256 => uint256) public nextWrId; // valifatorId -> wrId
    mapping(uint256 => mapping(uint256 => WithdrawRequest)) public withdrawals; // validatorId -> wrId -> withdraw request
    mapping(address => StakeRecord) public userStake;
    mapping(address => uint256) public userCurrentWithdrowalsAmount;

    event NewRate(uint256 indexed oldRate, uint256 indexed newRate);
    event NewStakeRatio(uint256 indexed oldRatio, uint256 indexed newRatio);
    event NewRewardRate(uint256 indexed oldRewardRate, uint256 indexed newRewardRate);
    event FailedToStash(uint256 validatorId);
    event NewValidatorId(uint256 indexed oldValidatorId, uint256 indexed newValidatorId);
    event Unstake(uint256 indexed validatorId, uint256 indexed wrId, uint256 indexed amount);
    event StakeWithdraw(uint256 indexed validatorId, uint256 indexed wrId, uint256 indexed amount);
    event Stake(address indexed user, uint256 indexed amountReceived);
    event Withdraw(address indexed user, uint256 indexed amount);
    event Restake(uint256 amountStaked);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        uint256 _rate,
        uint256 _stakeRatio,
        uint256 _rewardRate,
        uint256 _validatorId,
        address _sfc
    ) initializer public {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ERC20_init("Staked Token", "stTKN");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(UPGRADER_ROLE, msg.sender);

        setRate(_rate);
        setStakeRatio(_stakeRatio);
        setRewardRate(_rewardRate);
        
        require(_sfc != address(0));
        sfc = SFC(_sfc);

        require(sfc.getValidator(_validatorId).status == 0);
        validatorId = _validatorId;

        address constantsManager = sfc.constsAddress();
        c = ConstantsManager(constantsManager);
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        onlyRole(UPGRADER_ROLE)
        override
    {}

    function setRate(uint256 _rate) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_rate > 0, "Rate must be greater than 0");

        uint256 oldRate = rate;
        rate = _rate;

        emit NewRate(oldRate, _rate);   
    }

    function setStakeRatio(uint256 _stakeRatio) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_stakeRatio > 0, "Lockup Ratio must be greater then 0");

        uint256 oldRatio = stakeRatio;
        stakeRatio = _stakeRatio;

        emit NewStakeRatio(oldRatio, _stakeRatio);
    }

    function setRewardRate(uint256 _rewardRate) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_rewardRate > 0, "Reward rate must be greater than 0");

        uint256 oldRewardRate = rewardRate;
        rewardRate = _rewardRate;

        emit NewRewardRate(oldRewardRate, _rewardRate);
    }

    function setValidatorId(uint256 _validatorId) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_validatorId != validatorId, "New validator must be different from the old one");
        require(sfc.getValidator(_validatorId).auth != address(0) &&
                sfc.getValidator(_validatorId).status == 0, "New validator is inactive");

        uint256 rewardsStashed;
        try sfc.stashRewards(address(this), validatorId) {
            rewardsStashed = sfc.rewardsStash(address(this), validatorId);
            sfc.claimRewards(validatorId);            
        } catch {
            emit FailedToStash(validatorId);
        }
        
        uint256 unlockedStake = sfc.getUnlockedStake(address(this), validatorId);
        if (unlockedStake > 0) {
            uint256 wrId = nextWrId[validatorId];
            sfc.undelegate(validatorId, wrId, unlockedStake);
            
            uint256 requestedAmount = sfc.getWithdrawalRequest(address(this), validatorId, wrId).amount;
            require(requestedAmount == unlockedStake);
            
            withdrawals[validatorId][wrId] = WithdrawRequest({
                amount: unlockedStake,
                time: block.timestamp,
                withdrawn: false
            });
            
            emit Unstake(validatorId, wrId, unlockedStake);
            nextWrId[validatorId] = (++wrId);
        }

        uint256 oldValidatorId = validatorId;
        validatorId = _validatorId;
        emit NewValidatorId(oldValidatorId, _validatorId);
        
        uint256 amountToStake =  address(this).balance * stakeRatio / 100;
        if (amountToStake > 0) {
            sfc.delegate{value: amountToStake}(validatorId);
                        
            emit Restake(amountToStake);
        }
    }

    function withdrawStake(uint256 _validatorId, uint256 _wrId) public onlyRole(DEFAULT_ADMIN_ROLE) {
        _unstake(_validatorId, _wrId);
    }

    function _unstake(uint256 _validatorId, uint256 _wrId) private {
        require(withdrawals[_validatorId][_wrId].withdrawn == false);
        
        uint256 withdrawalPeriod = c.withdrawalPeriodTime();
        require(withdrawals[_validatorId][_wrId].time + withdrawalPeriod <= block.timestamp);

        sfc.withdraw(_validatorId, _wrId);
        uint256 amount = withdrawals[_validatorId][_wrId].amount;
        withdrawals[_validatorId][_wrId].withdrawn = true;
        emit StakeWithdraw(_validatorId, _wrId, amount);

        uint256 amountToStake = address(this).balance * stakeRatio / 100;
        sfc.delegate{value: amountToStake}(validatorId);

        emit Restake(amountToStake);
    }

    function stake() public payable {
        uint256 amount = msg.value;
        uint256 amountToStake = amount * stakeRatio / 100;

        sfc.delegate{value: amountToStake}(validatorId);

        uint256 currentSealedEpoch = sfc.currentSealedEpoch();
        uint256 lastStakeEpoch = userStake[msg.sender].lastStakeEpoch;
        uint256 totalAmountInStake = amount;
        uint256 rewards = 0;
        
        if (lastStakeEpoch != 0) {
            require(lastStakeEpoch <= currentSealedEpoch);

            totalAmountInStake += userStake[msg.sender].stakedAmount;
            rewards = calculateRewards(lastStakeEpoch, currentSealedEpoch);
        }

        userStake[msg.sender] = StakeRecord({
            lastStakeEpoch: currentSealedEpoch,
            stakedAmount: totalAmountInStake,
            rewards: rewards
        });
        _mint(msg.sender, (amount * rate / 100));

        emit Stake(msg.sender, amount);
    }

    receive() external payable {}

    function withdraw(uint256 amount, uint256[] memory wrIds) public returns (uint256) {
        address user = msg.sender;
        uint256 balance = balanceOf(user);
        require(balance >= amount, "Insufficient funds");
        uint256 amountToBurn = amount;

        uint256 currentSealedEpoch = sfc.currentSealedEpoch();
        uint256 lastStakeEpoch = userStake[user].lastStakeEpoch;

        uint256 shareOfBalance = amount * 100 / balance;
        uint256 TKNamount = amount * 100 / rate;

        if (lastStakeEpoch < currentSealedEpoch) {
            userStake[user].rewards = calculateRewards(lastStakeEpoch, currentSealedEpoch);
        }

        uint256 rewardsAmount = (userStake[user].rewards * shareOfBalance) / 100;
        uint256 rewardsToTransfer = (rewardsAmount * rewardRate) / 100;
        uint256 amountToTransfer = TKNamount + rewardsToTransfer;

        if (address(this).balance < amountToTransfer) {
            try sfc.claimRewards(validatorId) {} catch {}

            if (address(this).balance < amountToTransfer) {
                uint256 remainingAmount = amountToTransfer - address(this).balance;

                for (uint256 i = 0; i < wrIds.length; ++i) {
                    uint256 wrId = wrIds[i];
                    require(withdrawals[validatorId][wrId].time != 0, "wrong wr id");
                    uint256 wrIdAmount = withdrawals[validatorId][wrId].amount;
                    (, remainingAmount) = remainingAmount.trySub(wrIdAmount);

                    sfc.withdraw(validatorId, wrId);
                    withdrawals[validatorId][wrId].withdrawn = true;
                    emit StakeWithdraw(validatorId, wrId, withdrawals[validatorId][wrId].amount);

                    if (remainingAmount == 0) {
                        break;
                    }
                }

                if (remainingAmount > 0) {
                    uint256 wrId = nextWrId[validatorId];
                    
                    require(userCurrentWithdrowalsAmount[user] + remainingAmount <= userStake[user].stakedAmount, "withdrawal request limit reached");
                    sfc.undelegate(validatorId, wrId, remainingAmount);

                    userCurrentWithdrowalsAmount[user] += remainingAmount;               
                    withdrawals[validatorId][wrId] = WithdrawRequest({
                        amount: remainingAmount,
                        time: block.timestamp,
                        withdrawn: false
                    });
                    
                    emit Unstake(validatorId, wrId, remainingAmount);
                    nextWrId[validatorId] = (++wrId);
                    
                    amountToTransfer = (address(this).balance * stakeRatio) / 100;
                    amountToBurn = (amountToTransfer * rate) / 100;
                    TKNamount = amountToTransfer;
                }
            }

            uint256 amountToStake = (address(this).balance - amountToTransfer) * stakeRatio / 100;
            sfc.delegate{value: amountToStake}(validatorId);
        }

        userStake[user].rewards -= rewardsAmount;
        userStake[user].stakedAmount -= TKNamount;
        (, userCurrentWithdrowalsAmount[user]) = userCurrentWithdrowalsAmount[user].trySub(TKNamount);

        require(amountToBurn > 0);
        _burn(user, amountToBurn);
        payable(user).transfer(amountToTransfer);

        emit Withdraw(user, amountToTransfer);
        return amountToTransfer;
    }

    function restakeRewards() public onlyRole(DEFAULT_ADMIN_ROLE) {
        sfc.claimRewards(validatorId);

        uint256 amountToStake =  address(this).balance * stakeRatio / 100;
        sfc.delegate{value: amountToStake}(validatorId);

        emit Restake(amountToStake);
    }

    function calculateRewards(uint256 lastStakeEpoch, uint256 currentSealedEpoch) internal returns (uint256) {
        uint256 amountInStake = (userStake[msg.sender].stakedAmount * stakeRatio) / 100;
        uint256 stakedRate = sfc.getEpochAccumulatedRewardPerToken(lastStakeEpoch, validatorId);
        uint256 currentRate = sfc.getEpochAccumulatedRewardPerToken(currentSealedEpoch, validatorId);
        uint256 unlockedRewardRatio = c.unlockedRewardRatio();
        
        return ((currentRate.sub(stakedRate)).mul(amountInStake).div(1e18)).mul(unlockedRewardRatio).div(1e18);
    }

    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        address owner = _msgSender();
        uint256 balance = balanceOf(owner);
        uint256 shareOfBalance = amount * 100 / balance;

        uint256 currentSealedEpoch = sfc.currentSealedEpoch();
        uint256 lastStakeEpoch = userStake[owner].lastStakeEpoch;

        if (lastStakeEpoch < currentSealedEpoch) {
            userStake[owner].rewards = calculateRewards(lastStakeEpoch, currentSealedEpoch);
        }

        uint256 ownerStakeShare = (userStake[owner].stakedAmount * shareOfBalance) / 100;
        uint256 ownerRewardsShare = (userStake[owner].rewards * shareOfBalance) / 100;

        userStake[to].lastStakeEpoch = userStake[owner].lastStakeEpoch;
        userStake[to].stakedAmount += ownerStakeShare;
        userStake[to].rewards += ownerRewardsShare;

        userStake[owner].stakedAmount -= ownerStakeShare;
        userStake[owner].rewards -= ownerRewardsShare;

        _transfer(owner, to, amount);

        return true;
    }

    function getAvailableWithdrowalAmount() public returns(uint256 unstakedCoins, uint256 userStakedCoins, uint256 userRewards) {
        uint256 currentSealedEpoch = sfc.currentSealedEpoch();
        uint256 lastStakeEpoch = userStake[msg.sender].lastStakeEpoch;

        if (lastStakeEpoch < currentSealedEpoch) {
            userStake[msg.sender].rewards = calculateRewards(lastStakeEpoch, currentSealedEpoch);
        }

        unstakedCoins = address(this).balance;
        userStakedCoins = userStake[msg.sender].stakedAmount;
        userRewards = userStake[msg.sender].rewards;
    }
}