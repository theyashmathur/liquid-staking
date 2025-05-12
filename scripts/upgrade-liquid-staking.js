const { ethers } = require("hardhat");
const { upgrades } = require("hardhat");
require('dotenv').config();

async function main() {
    const [deployer] = await ethers.getSigners();
    const LiquidStakingContractAddress = "0xf7A01EA5b9F05EA575fe3B4D363bD96Fb5513f57";
  
    console.log(
      "Upgrading contracts with the account:",
      deployer.address
    );
      
    console.log("Account balance:", (await deployer.getBalance()).toString());
    
    const LiquidStaking = await ethers.getContractFactory("LiquidStaking");
    const liquidStaking = await upgrades.upgradeProxy(LiquidStakingContractAddress, LiquidStaking, { initializer: 'initialize', kind: 'uups' });
    await liquidStaking.deployed();

    console.log("Liquid Staking deployed to:", liquidStaking.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });