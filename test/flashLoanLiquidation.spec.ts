import { BigNumber, constants, Contract, providers, utils } from "ethers";
import { deployments, ethers } from "hardhat";
import { createPool, deployAssets, setUpPriceOraclePrices } from "./utils";
import { DeployedAsset, getPoolAssets } from "./utils/pool";
import { addCollateral, borrowCollateral } from "./utils/collateral";
import { CErc20, CEther, EIP20Interface, FuseSafeLiquidator, MasterPriceOracle, SimplePriceOracle } from "../typechain";
import { expect } from "chai";
import { cERC20Conf, ERC20Abi } from "../lib/esm/src";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { whaleSigner } from "./utils/accounts";

const UNISWAP_V2_PROTOCOLS = {
    Uniswap: {
        router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        factory: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
    },
    SushiSwap: {
        router: "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
        factory: "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac",
    },
    PancakeSwap: {
        router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
        factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    },
};

describe.skip("#safeLiquidate", () => {
    let whale: SignerWithAddress;

    let eth: cERC20Conf;
    let erc20One: cERC20Conf;
    let erc20Two: cERC20Conf;

    let deployedEth: DeployedAsset;
    let deployedErc20One: DeployedAsset;
    let deployedErc20Two: DeployedAsset;

    let poolAddress: string;
    let simpleOracle: SimplePriceOracle;
    let oracle: MasterPriceOracle;
    let liquidator: FuseSafeLiquidator;

    let ethCToken: CEther;
    let erc20OneCToken: CErc20;
    let erc20TwoCToken: CErc20;

    let erc20OneUnderlying: EIP20Interface;
    let erc20TwoUnderlying: EIP20Interface;
    let tx: providers.TransactionResponse;

    beforeEach(async () => {
        await deployments.fixture(); // ensure you start from a fresh deployments
        await setUpPriceOraclePrices();
        const { bob, deployer, rando } = await ethers.getNamedSigners();

        simpleOracle = (await ethers.getContract("SimplePriceOracle", deployer)) as SimplePriceOracle;
        oracle = (await ethers.getContract("MasterPriceOracle", deployer)) as MasterPriceOracle;

        [poolAddress] = await createPool({});
        const assets = await getPoolAssets(poolAddress);

        erc20One = assets.assets.find((a) => a.underlying !== constants.AddressZero); // find first one
        expect(erc20One.underlying).to.be.ok;
        erc20Two = assets.assets.find(
            (a) => a.underlying !== constants.AddressZero && a.underlying !== erc20One.underlying
        ); // find second one

        expect(erc20Two.underlying).to.be.ok;
        eth = assets.assets.find((a) => a.underlying === constants.AddressZero);

        await oracle.add(
            [eth.underlying, erc20One.underlying, erc20Two.underlying],
            Array(3).fill(simpleOracle.address)
        );

        tx = await simpleOracle.setDirectPrice(eth.underlying, utils.parseEther("1"));
        await tx.wait();

        tx = await simpleOracle.setDirectPrice(erc20One.underlying, utils.parseEther("10"));
        await tx.wait();

        tx = await simpleOracle.setDirectPrice(erc20Two.underlying, utils.parseEther("0.0001"));
        await tx.wait();

        const deployedAssets = await deployAssets(assets.assets, bob);

        deployedEth = deployedAssets.find((a) => a.underlying === constants.AddressZero);
        deployedErc20One = deployedAssets.find((a) => a.underlying === erc20One.underlying);
        deployedErc20Two = deployedAssets.find((a) => a.underlying === erc20Two.underlying);

        liquidator = (await ethers.getContract("FuseSafeLiquidator", rando)) as FuseSafeLiquidator;

        ethCToken = (await ethers.getContractAt("CEther", deployedEth.assetAddress)) as CEther;
        erc20OneCToken = (await ethers.getContractAt("CErc20", deployedErc20One.assetAddress)) as CErc20;
        erc20TwoCToken = (await ethers.getContractAt("CErc20", deployedErc20Two.assetAddress)) as CErc20;

        erc20TwoUnderlying = (await ethers.getContractAt("EIP20Interface", erc20Two.underlying)) as EIP20Interface;
        erc20OneUnderlying = (await ethers.getContractAt("EIP20Interface", erc20One.underlying)) as EIP20Interface;
    });

    it("should liquidate a native borrow for token collateral", async function () {
        const { alice, bob, rando } = await ethers.getNamedSigners();

        // either use configured whale acct or bob
        whale = await whaleSigner();
        if (!whale) {
            whale = bob;
        }

        // Supply 0.1 tokenOne from other account
        await addCollateral(poolAddress, whale, erc20One.symbol, "0.1", true);
        console.log(`Added ${erc20One.symbol} collateral`);

        // Supply 1 native from other account
        await addCollateral(poolAddress, alice, eth.symbol, "1", false);

        // Borrow 0.5 native using token collateral
        const borrowAmount = "0.5";
        await borrowCollateral(poolAddress, whale.address, eth.symbol, borrowAmount);

        // Set price of tokenOne collateral to 1/10th of what it was
        tx = await simpleOracle.setDirectPrice(erc20One.underlying, utils.parseEther("1"));
        await tx.wait();

        const repayAmount = utils.parseEther(borrowAmount).div(10);
        const balBefore = await erc20OneCToken.balanceOf(rando.address);

        // Defaults
        // const exchangeTo = tokenCollateral;
        const exchangeTo = constants.AddressZero;

        const uniswapV2RouterForCollateral = UNISWAP_V2_PROTOCOLS.PancakeSwap.router;

        // Check balance before liquidation

        const liquidatorBalanceBeforeLiquidation =
            exchangeTo === "0x0000000000000000000000000000000000000000"
                ? await ethers.provider.getBalance(rando.address)
                : await (
                      (await ethers.getContractAt("EIP20Interface", erc20Two.underlying)) as EIP20Interface
                  ).balanceOf(rando.address);
        const assetContract = new Contract(deployedEth.assetAddress, ERC20Abi, whale);
        tx = await assetContract.approve(whale.address, BigNumber.from(2).pow(BigNumber.from(256)).sub(constants.One));
        await tx.wait();

        const assetOneContract = new Contract(deployedErc20One.assetAddress, ERC20Abi, whale);
        tx = await assetOneContract.approve(
            whale.address,
            BigNumber.from(2).pow(BigNumber.from(256)).sub(constants.One)
        );
        await tx.wait();

        // Liquidate borrow
        tx = await liquidator[
            "safeLiquidateToEthWithFlashLoan(address,uint256,address,address,uint256,address,address,address[],bytes[],uint256)"
        ](
            whale.address,
            repayAmount,
            deployedEth.assetAddress,
            deployedErc20One.assetAddress,
            0,
            exchangeTo,
            uniswapV2RouterForCollateral,
            [],
            [],
            0
        );
        // Assert balance after liquidation > balance before liquidation
        const liquidatorBalanceAfterLiquidation =
            exchangeTo === "0x0000000000000000000000000000000000000000"
                ? await ethers.provider.getBalance(rando.address)
                : await (
                      (await ethers.getContractAt("EIP20Interface", erc20Two.underlying)) as EIP20Interface
                  ).balanceOf(rando.address);

        expect(liquidatorBalanceAfterLiquidation.gt(liquidatorBalanceBeforeLiquidation));

        // tx = await liquidator["safeLiquidate(address,address,address,uint256,address,address,address[],bytes[])"](
        //   whale.address,
        //   deployedEth.assetAddress,
        //   deployedErc20One.assetAddress,
        //   0,
        //   deployedErc20One.assetAddress,
        //   constants.AddressZero,
        //   [],
        //   [],
        //   { value: repayAmount, gasLimit: 10000000, gasPrice: utils.parseUnits("10", "gwei") }
        // );
        // await tx.wait();

        const balAfter = await erc20OneCToken.balanceOf(rando.address);
        expect(balAfter).to.be.gt(balBefore);
    });

    // Safe liquidate token borrows
    it("should liquidate a token borrow for native collateral", async function () {
        const { alice, bob, rando } = await ethers.getNamedSigners();
        whale = await whaleSigner();
        if (!whale) {
            whale = alice;
        }

        // Supply native collateral
        await addCollateral(poolAddress, bob, eth.symbol, "0.1", true);

        // Supply tokenOne from other account
        await addCollateral(poolAddress, whale, erc20One.symbol, "0.01", true);

        // Borrow tokenOne using native as collateral
        const borrowAmount = "0.005";
        await borrowCollateral(poolAddress, bob.address, erc20One.symbol, borrowAmount);

        const originalPrice = await oracle.getUnderlyingPrice(deployedErc20One.assetAddress);

        // Set price of borrowed token to 10x of what it was
        tx = await simpleOracle.setDirectPrice(deployedErc20One.underlying, BigNumber.from(originalPrice).mul(10));
        await tx.wait();

        const balBefore = await ethCToken.balanceOf(rando.address);
        const repayAmount = utils.parseEther(borrowAmount).div(15);

        tx = await erc20OneUnderlying.connect(whale).transfer(rando.address, repayAmount);
        tx = await erc20OneUnderlying.connect(rando).approve(liquidator.address, constants.MaxUint256);
        await tx.wait();

        tx = await liquidator[
            "safeLiquidate(address,uint256,address,address,uint256,address,address,address[],bytes[])"
        ](
            bob.address,
            repayAmount,
            deployedErc20One.assetAddress,
            deployedEth.assetAddress,
            0,
            deployedEth.assetAddress,
            constants.AddressZero,
            [],
            []
        );
        await tx.wait();

        const balAfter = await ethCToken.balanceOf(rando.address);
        expect(balAfter).to.be.gt(balBefore);
    });

    it("should liquidate a token borrow for token collateral", async function () {
        const { alice, bob, rando } = await ethers.getNamedSigners();
        whale = await whaleSigner();
        if (!whale) {
            whale = alice;
        }

        // send some tokens from whale to supplier
        tx = await erc20OneUnderlying.connect(whale).transfer(bob.address, utils.parseEther("1"));

        const originalPrice = await oracle.getUnderlyingPrice(deployedErc20One.assetAddress);

        // Supply tokenOne collateral
        await addCollateral(poolAddress, bob, erc20One.symbol, "0.5", true);

        // Supply tokenTwo from other account
        await addCollateral(poolAddress, whale, erc20Two.symbol, "10000", false);

        // Borrow tokenTwo using tokenOne collateral
        const borrowAmount = "5000";
        await borrowCollateral(poolAddress, bob.address, erc20Two.symbol, borrowAmount);

        // Set price of tokenOne collateral to 1/10th of what it was
        tx = await simpleOracle.setDirectPrice(erc20One.underlying, BigNumber.from(originalPrice).div(10));
        await tx.wait();

        const repayAmount = utils.parseEther(borrowAmount).div(15);

        const balBefore = await erc20OneCToken.balanceOf(rando.address);

        tx = await erc20TwoUnderlying.connect(whale).transfer(rando.address, repayAmount);
        tx = await erc20TwoUnderlying.connect(rando).approve(liquidator.address, constants.MaxUint256);

        await tx.wait();

        tx = await liquidator[
            "safeLiquidate(address,uint256,address,address,uint256,address,address,address[],bytes[])"
        ](
            bob.address,
            repayAmount,
            deployedErc20Two.assetAddress,
            deployedErc20One.assetAddress,
            0,
            deployedErc20One.assetAddress,
            constants.AddressZero,
            [],
            []
        );

        const balAfter = await erc20OneCToken.balanceOf(rando.address);
        expect(balAfter).to.be.gt(balBefore);
    });
});