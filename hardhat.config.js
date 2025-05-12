require("@nomicfoundation/hardhat-toolbox");
require('@openzeppelin/hardhat-upgrades');

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: '0.5.17',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          },
        },
      },
      {
        version: '0.8.20',
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            details: {
              yulDetails: {
                optimizerSteps: "u",
              },
            },
            runs: 13370
          },
          evmVersion: "london",
        }
      },
    ],
  },
  networks: {
    localhost: {
      allowUnlimitedContractSize: true,
      timeout: 1800000,      
    },
    hardhat: {
      allowUnlimitedContractSize: true,
      timeout: 1800000,      
    },
    polygon_mumbai: {
      url: "https://polygon-mumbai-bor.publicnode.com",
      gasPrice: 35000000000,
      saveDeployments: true,
    },
  },
};
