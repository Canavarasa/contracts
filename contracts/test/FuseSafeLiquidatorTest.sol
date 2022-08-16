// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0;

import "ds-test/test.sol";
import "forge-std/Vm.sol";

import { CToken } from "../compound/CToken.sol";
import { Comptroller } from "../compound/Comptroller.sol";
import { CErc20Delegate } from "../compound/CErc20Delegate.sol";
import { MasterPriceOracle } from "../oracles/MasterPriceOracle.sol";
import { WETH } from "solmate/tokens/WETH.sol";

import "../FuseSafeLiquidator.sol";
import "../FusePoolLens.sol";
import "openzeppelin-contracts-upgradeable/contracts/token/ERC20/IERC20Upgradeable.sol";
import "./config/BaseTest.t.sol";
import "../liquidators/JarvisLiquidatorFunder.sol";
import "../liquidators/CurveLpTokenLiquidator.sol";
import "../liquidators/UniswapLpTokenLiquidator.sol";
import "../liquidators/CurveLpTokenLiquidatorNoRegistry.sol";

contract MockRedemptionStrategy is IRedemptionStrategy {
  function redeem(
    IERC20Upgradeable inputToken,
    uint256 inputAmount,
    bytes memory strategyData
  ) external returns (IERC20Upgradeable outputToken, uint256 outputAmount) {
    return (IERC20Upgradeable(address(0)), 1);
  }
}

contract FuseSafeLiquidatorTest is BaseTest {
  FuseSafeLiquidator fsl;
  address alice = address(10);
  address uniswapRouter = 0x10ED43C718714eb63d5aA57B78B54704E256024E;

  function setUp() public {
    if (block.chainid == BSC_MAINNET) {
      // the proxy/storage is using slot 51 for the owner address
      fsl = FuseSafeLiquidator(payable(0xc9C3D317E89f4390A564D56180bBB1842CF3c99C));
    } else {
      fsl = new FuseSafeLiquidator();
      fsl.initialize(address(1), address(2), address(3), address(4), "", 30);
    }
  }

  function testWhitelistRevert() public {
    IERC20Upgradeable underlyingCollateral = IERC20Upgradeable(address(0));
    uint256 underlyingCollateralSeized = 1;
    IRedemptionStrategy strategy = new MockRedemptionStrategy();
    bytes memory strategyData = "";

    vm.expectRevert("only whitelisted redemption strategies can be used");
    fsl.redeemCustomCollateral(underlyingCollateral, underlyingCollateralSeized, strategy, strategyData);
  }

  function testWhitelist() public {
    IERC20Upgradeable underlyingCollateral = IERC20Upgradeable(address(0));
    uint256 underlyingCollateralSeized = 1;
    IRedemptionStrategy strategy = new MockRedemptionStrategy();
    bytes memory strategyData = "";

    vm.prank(fsl.owner());
    fsl._whitelistRedemptionStrategy(strategy, true);
    fsl.redeemCustomCollateral(underlyingCollateral, underlyingCollateralSeized, strategy, strategyData);
  }

  function testUpgrade() public {
    //    emit log_address(fsl.owner());

    // in case these slots start to get used, please redeploy the FSL
    // with a larger storage gap to protect the owner variable of OwnableUpgradeable
    // from being overwritten by the FuseSafeLiquidator storage
    for (uint256 i = 40; i < 51; i++) {
      //      emit log_uint(i);
      address atSloti = address(uint160(uint256(vm.load(address(fsl), bytes32(i)))));
      //      emit log_address(atSloti);
      assertEq(
        atSloti,
        address(0),
        "replace the FSL proxy/storage contract with a new one before the owner variable is overwritten"
      );
    }
  }

  struct LiquidationData {
    FusePoolDirectory.FusePool[] pools;
    address[] cTokens;
    IRedemptionStrategy[] strategies;
    bytes[] redemptionDatas;
    CToken[] markets;
    address[] borrowers;
    FuseSafeLiquidator liquidator;
    IFundsConversionStrategy[] fundingStrategies;
    bytes[] fundingDatas;
    CErc20Delegate debtMarket;
    CErc20Delegate collateralMarket;
    Comptroller comptroller;
    address borrower;
  }

  function getPoolAndBorrower(uint256 random, LiquidationData memory vars)
    internal
    view
    returns (Comptroller, address)
  {
    if (vars.pools.length == 0) revert("no pools to pick from");

    uint256 i = random % vars.pools.length; // random pool
    Comptroller comptroller = Comptroller(vars.pools[i].comptroller);
    address[] memory borrowers = comptroller.getAllBorrowers();

    if (borrowers.length == 0) {
      return (Comptroller(address(0)), address(0));
    } else {
      uint256 k = random % borrowers.length; // random borrower
      address borrower = borrowers[k];

      return (comptroller, borrower);
    }
  }

  function setUpDebtAndCollateralMarkets(uint256 random, LiquidationData memory vars)
    internal
    returns (
      CErc20Delegate debt,
      CErc20Delegate collateral,
      uint256 borrowAmount
    )
  {
    // debt
    for (uint256 m = 0; m < vars.markets.length; m++) {
      uint256 marketIndexWithOffset = (random + m) % vars.markets.length;
      borrowAmount = vars.markets[marketIndexWithOffset].borrowBalanceStored(vars.borrower);
      if (borrowAmount > 0) {
        debt = CErc20Delegate(address(vars.markets[marketIndexWithOffset]));
        break;
      }
    }

    if (address(debt) != address(0)) {
      emit log("debt market is");
      emit log_address(address(debt));

      uint256 shortfall = 0;
      // reduce the collateral for each market of the borrower
      // until there is shortfall for which to be liquidated
      for (uint256 m = 0; m < vars.markets.length; m++) {
        uint256 marketIndexWithOffset = (random - m) % vars.markets.length;
        if (vars.markets[marketIndexWithOffset].balanceOf(vars.borrower) > 0) {
          if (address(vars.markets[marketIndexWithOffset]) == address(debt)) continue;

          collateral = CErc20Delegate(address(vars.markets[marketIndexWithOffset]));

          // the collateral prices change
          MasterPriceOracle mpo = MasterPriceOracle(address(vars.comptroller.oracle()));
          uint256 priceCollateral = mpo.getUnderlyingPrice(ICToken(address(collateral)));
          vm.mockCall(
            address(mpo),
            abi.encodeWithSelector(mpo.getUnderlyingPrice.selector, ICToken(address(collateral))),
            abi.encode(priceCollateral / 5)
          );

          (, , shortfall) = vars.comptroller.getAccountLiquidity(vars.borrower);
          if (shortfall == 0) {
            emit log("collateral still enough");
            continue;
          } else {
            emit log("has shortfall");
            break;
          }
        }
      }
      if (shortfall == 0) {
        return (CErc20Delegate(address(0)), CErc20Delegate(address(0)), 0);
      }
    }
  }

  function testAnyLiquidation(uint256 random) public shouldRun(forChains(BSC_MAINNET)) {
    vm.assume(random > 100 && random < type(uint64).max);

    LiquidationData memory vars;
    uint256 borrowAmount;

    // setting up a new liquidator
    //    vars.liquidator = FuseSafeLiquidator(payable(0xc9C3D317E89f4390A564D56180bBB1842CF3c99C));
    vars.liquidator = new FuseSafeLiquidator();
    vars.liquidator.initialize(
      ap.getAddress("wtoken"),
      uniswapRouter,
      ap.getAddress("bUSD"),
      0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c, // BTCB
      "0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5",
      25
    );
    vars.pools = FusePoolDirectory(0x295d7347606F4bd810C8296bb8d75D657001fcf7).getAllPools();

    // get a random pool and a random borrower from it
    (vars.comptroller, vars.borrower) = getPoolAndBorrower(random, vars);

    if (address(vars.comptroller) == address(0) || vars.borrower == address(0)) {
      // fuzz test another number
      return;
    }

    // find a market in which the borrower has debt and reduce his collateral price
    if (address(vars.comptroller) != address(0) && vars.borrower != address(0)) {
      vars.markets = vars.comptroller.getAllMarkets();
      (vars.debtMarket, vars.collateralMarket, borrowAmount) = setUpDebtAndCollateralMarkets(random, vars);
    }

    emit log("debt and collateral markets");
    emit log_address(address(vars.debtMarket));
    emit log_address(address(vars.collateralMarket));

    if (address(vars.debtMarket) == address(0) || address(vars.collateralMarket) == address(0)) {
      // fuzz test another number
      return;
    }

    // prepare the liquidation
    address exchangeTo; // = vars.collateralMarket.underlying(); // same as collateral
    address flashSwapFundingToken;

    // prepare the funding strategies
    if (vars.debtMarket.underlying() == 0x316622977073BBC3dF32E7d2A9B3c77596a0a603) {
      // jbrl
      vars.fundingStrategies = new IFundsConversionStrategy[](1);
      vars.fundingDatas = new bytes[](1);
      vars.fundingDatas[0] = abi.encode(
        address(0x316622977073BBC3dF32E7d2A9B3c77596a0a603),
        0x0fD8170Dc284CD558325029f6AEc1538c7d99f49,
        60 * 40
      );
      vars.fundingStrategies[0] = new JarvisLiquidatorFunder();
      flashSwapFundingToken = ap.getAddress("bUSD");

      // all strategies need to be whitelisted
      vm.prank(vars.liquidator.owner());
      vars.liquidator._whitelistRedemptionStrategy(vars.fundingStrategies[0], true);
    } else {
      vars.fundingStrategies = new IFundsConversionStrategy[](0);
      vars.fundingDatas = new bytes[](0);
      flashSwapFundingToken = vars.debtMarket.underlying();
    }

    exchangeTo = flashSwapFundingToken;

    // prepare the redemption strategies
    if (vars.collateralMarket.underlying() == 0x1B6E11c5DB9B15DE87714eA9934a6c52371CfEA9) {
      // 2brl
      vars.strategies = new IRedemptionStrategy[](2);
      vars.strategies[0] = new CurveLpTokenLiquidatorNoRegistry(
        WETH(payable(ap.getAddress("wtoken"))),
        CurveLpTokenPriceOracleNoRegistry(0x4544d21EB5B368b3f8F98DcBd03f28aC0Cf6A0CA)
      );
      vars.strategies[1] = new JarvisLiquidatorFunder();
      vars.redemptionDatas = new bytes[](2);
      vars.redemptionDatas[0] = abi.encode(uint8(0), 0x316622977073BBC3dF32E7d2A9B3c77596a0a603);
      vars.redemptionDatas[1] = abi.encode(
        address(0x316622977073BBC3dF32E7d2A9B3c77596a0a603),
        0x0fD8170Dc284CD558325029f6AEc1538c7d99f49,
        60 * 40
      );

      // all strategies need to be whitelisted
      vm.prank(vars.liquidator.owner());
      vars.liquidator._whitelistRedemptionStrategy(vars.strategies[0], true);
      vars.liquidator._whitelistRedemptionStrategy(vars.strategies[1], true);
    } else if (vars.collateralMarket.underlying() == 0xd99c7F6C65857AC913a8f880A4cb84032AB2FC5b) {
      vars.strategies = new IRedemptionStrategy[](1);
      vars.strategies[0] = new UniswapLpTokenLiquidator();
      vars.redemptionDatas = new bytes[](1);
      address[] memory swapToken0Path = new address[](0);
      address[] memory swapToken1Path = new address[](2);
      swapToken1Path[0] = ap.getAddress("wtoken");
      swapToken1Path[1] = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d; // USDC
      vars.redemptionDatas[0] = abi.encode(uniswapRouter, swapToken0Path, swapToken1Path);
      // all strategies need to be whitelisted
      vm.prank(vars.liquidator.owner());
      vars.liquidator._whitelistRedemptionStrategy(vars.strategies[0], true);
    } else {
      vars.strategies = new IRedemptionStrategy[](0);
      vars.redemptionDatas = new bytes[](0);
    }

    // liquidate
    vm.prank(ap.owner());
    vars.liquidator.safeLiquidateToTokensWithFlashLoan(
      FuseSafeLiquidator.LiquidateToTokensWithFlashSwapVars(
        vars.borrower,
        borrowAmount / 100, //repayAmount,
        ICErc20(address(vars.debtMarket)),
        ICErc20(address(vars.collateralMarket)),
        0,
        exchangeTo,
        flashSwapFundingToken,
        IUniswapV2Router02(uniswapRouter),
        IUniswapV2Router02(uniswapRouter),
        vars.strategies,
        vars.redemptionDatas,
        0,
        vars.fundingStrategies,
        vars.fundingDatas
      )
    );
  }
}
