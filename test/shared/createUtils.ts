import { BigNumber, constants, Contract, utils, Wallet } from 'ethers'

import { getMaxTick, getMinTick } from './ticks'
import { FeeAmount, TICK_SPACINGS } from './constants'
import { encodePriceSqrt, sortedTokens } from './utils'
import { DEFAULT_FEE, INIT_PAIR_LP_AMOUNT_6, INIT_PAIR_LP_AMOUNT_18 } from './fixtures'
import poolAtAddress from './poolAtAddress'
import { computePoolAddress } from './computePoolAddress'
import HotPotV3FundAbi from '../../artifacts/contracts/HotPotV3Fund.sol/HotPotV3Fund.json'
import { IHotPotV3Fund, IHotPotV3FundFactory } from '../../typechain'
import { CompleteFixture } from './completeFixture'


export async function createUniV3PoolAndInit(miner: Wallet,
                                             fixture: CompleteFixture,
                                             tokenA: Contract,
                                             tokenB: Contract) {
  const tokens = sortedTokens(tokenA, tokenB);
  const token0 = (tokens[0] as Contract).connect(miner);
  const token1 = (tokens[1] as Contract).connect(miner);
  await token0.approve(fixture.nft.address, 0);
  await token0.approve(fixture.nft.address, constants.MaxUint256);
  await token1.approve(fixture.nft.address, 0);
  await token1.approve(fixture.nft.address, constants.MaxUint256);

  let amount0 = await token0.decimals() == 18 ? INIT_PAIR_LP_AMOUNT_18 : INIT_PAIR_LP_AMOUNT_6
  let amount1 = await token1.decimals() == 18 ? INIT_PAIR_LP_AMOUNT_18 : INIT_PAIR_LP_AMOUNT_6;

  const sqrtPriceX96 = encodePriceSqrt(amount1, amount0);
  const tick = await fixture.tickMath.getTickAtSqrtRatio(sqrtPriceX96);
  const tickSpacing = TICK_SPACINGS[DEFAULT_FEE];
  const tickLower = Math.floor((tick - 5000) / tickSpacing) * tickSpacing;
  const tickUpper = Math.floor((tick + 5000) / tickSpacing) * tickSpacing;

  await fixture.nft.createAndInitializePoolIfNecessary(
    token0.address, token1.address, FeeAmount.MEDIUM, sqrtPriceX96);
  let pool =  poolAtAddress(computePoolAddress(await fixture.nft.factory(), [token0.address, token1.address], FeeAmount.MEDIUM), miner);
  await pool.increaseObservationCardinalityNext(2);
  const params = {
    token0: token0.address, token1: token1.address, fee: DEFAULT_FEE,
    tickLower: tickLower, tickUpper: tickUpper,
    amount0Desired: amount0, amount1Desired: amount1,
    amount0Min: 0, amount1Min: 0,
    recipient: miner.address,
    deadline: 1
  };
  await fixture.nft.mint(params);
  return pool;
}


export async function createFund(manager: Wallet,
                                 token: Contract,
                                 depositor: string,
                                 lockPeriod: number,
                                 baseLine: number,
                                 managerFee: number,
                                 hotPotFactory: IHotPotV3FundFactory) {
  await hotPotFactory.connect(manager).createFund(token.address, utils.formatBytes32String(depositor), lockPeriod, baseLine, managerFee);
  const fundAddress = await hotPotFactory.getFund(manager.address, token.address, lockPeriod, baseLine, managerFee);
  return new Contract(fundAddress, HotPotV3FundAbi.abi, hotPotFactory.provider) as IHotPotV3Fund;
}








