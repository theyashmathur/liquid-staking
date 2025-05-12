const { ethers } = require("hardhat");
const { upgrades } = require("hardhat");
require('dotenv').config();

async function main() {
    const [deployer] = await ethers.getSigners();
  
    console.log(
      "Deploying contracts with the account:",
      deployer.address
    );
      
    console.log("Account balance:", (await deployer.getBalance()).toString());
    
    const LiquidStaking = await ethers.getContractFactory("LiquidStaking");
    const liquidStaking = await upgrades.deployProxy(LiquidStaking,
      [process.env.RATE, process.env.STAKE_RATIO, process.env.REWARD_RATIO, process.env.VALIDATOR_ID, process.env.SFC],
      { initializer: 'initialize', kind: 'uups' });
    await liquidStaking.deployed();

    console.log("Liquid Staking deployed to:", liquidStaking.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });