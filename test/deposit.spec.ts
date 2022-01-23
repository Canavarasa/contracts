import { expect } from "chai";
import { constants, Contract, utils } from "ethers";
import { ethers } from "hardhat";
import { createPool, setupTest } from "./utils";
import { deployAssets, ethAssetInPool, getAssetsConf, getPoolIndex } from "./utils/pool";
import { Fuse } from "../lib/esm/src";
import { FusePoolData, USDPricedFuseAsset } from "../lib/esm/src/Fuse/types";

describe("Deposit flow tests", function () {
  this.beforeEach(async () => {
    await setupTest();
  });

  describe("Deposit flow", async function () {
    let poolImplementationAddress: string;
    let poolAddress: string;
    const POOL_NAME = "test pool bob";

    beforeEach(async () => {
      this.timeout(120_000);
      const { bob } = await ethers.getNamedSigners();
      [poolAddress, poolImplementationAddress] = await createPool({ poolName: POOL_NAME, signer: bob });
      const sdk = new Fuse(ethers.provider, "1337");
      const assets = await getAssetsConf(poolAddress);
      await deployAssets(assets.assets, bob);
      const fusePoolData = await sdk.contracts.FusePoolLens.callStatic.getPoolAssetsWithData(poolAddress);
      expect(fusePoolData.length).to.eq(3);
      expect(fusePoolData.at(-1)[3]).to.eq("TRIBE");
    });

    it("should enable native asset as collateral into pool and supply", async function () {
      let tx;
      let rec;
      let cToken: Contract;
      let ethAsset: USDPricedFuseAsset;
      let ethAssetAfterBorrow: USDPricedFuseAsset;
      const { bob } = await ethers.getNamedSigners();

      const sdk = new Fuse(ethers.provider, "1337");

      const poolId = (await getPoolIndex(poolAddress, bob.address, sdk)).toString();
      const assetsInPool: FusePoolData = await sdk.fetchFusePoolData(poolId, bob.address);

      for (const asset of assetsInPool.assets) {
        if (asset.underlyingToken === constants.AddressZero) {
          cToken = new Contract(asset.cToken, sdk.chainDeployment.CEtherDelegate.abi, bob);
          const pool = await ethers.getContractAt("Comptroller", poolAddress, bob);
          tx = await pool.enterMarkets([asset.cToken]);
          await tx.wait();
          tx = await cToken.mint({ value: utils.parseUnits("2", 18) });
          rec = await tx.wait();
          expect(rec.status).to.eq(1);
        } else {
          cToken = new Contract(asset.cToken, sdk.chainDeployment.CErc20Delegate.abi, bob);
        }
      }

      ethAsset = await ethAssetInPool(poolId, sdk, bob);
      const cEther = new Contract(ethAsset.cToken, sdk.chainDeployment.CEtherDelegate.abi, bob);
      tx = await cEther.callStatic.borrow(utils.parseUnits("1.5", 18));
      expect(tx).to.eq(0);
      tx = await cEther.callStatic.borrow(utils.parseUnits("0.5", 18));
      expect(tx).to.eq(1019);
      tx = await cEther.borrow(utils.parseUnits("1.5", 18));
      rec = await tx.wait();
      expect(rec.status).to.eq(1);
      ethAssetAfterBorrow = await ethAssetInPool(poolId, sdk, bob);
      expect(ethAsset.borrowBalance.lt(ethAssetAfterBorrow.borrowBalance)).to.eq(true);
      console.log(ethAssetAfterBorrow.borrowBalanceUSD, "Borrow Balance USD: AFTER mint & borrow");
      console.log(ethAssetAfterBorrow.supplyBalanceUSD, "Supply Balance USD: AFTER mint & borrow");
    });
  });
});