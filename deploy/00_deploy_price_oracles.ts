import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async ({ ethers, getNamedAccounts, deployments }): Promise<void> => {
  const { bob, deployer } = await getNamedAccounts();

  let dep = await deployments.deterministic("MasterPriceOracle", {
    from: deployer,
    salt: ethers.utils.keccak256(deployer),
    args: [],
    log: true,
  });
  const masterPO = await dep.deploy();
  console.log("MasterPriceOracle: ", masterPO.address);

  dep = await deployments.deterministic("MockPriceOracle", {
    from: bob,
    salt: ethers.utils.keccak256(deployer),
    args: [100],
    log: true,
  });
  const mockPO = await dep.deploy();
  console.log("MockPriceOracle: ", mockPO.address);

  const masterPriceOracle = await ethers.getContract("MasterPriceOracle", deployer);
  const mockPriceOracle = await ethers.getContract("MockPriceOracle", deployer);

  const underlyings = [
    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", // AAVE
    "0x8a12Be339B0cD1829b91Adc01977caa5E9ac121e", // CRV
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  ];

  let tx = await masterPriceOracle.initialize(
    underlyings,
    Array(4).fill(mockPriceOracle.address),
    mockPriceOracle.address,
    deployer,
    true
  );
  await tx.wait();
};
func.tags = ["Oracles"];
export default func;
