import { abi as FUND_ABI } from '../../artifacts/contracts/HotPotV3Fund.sol/HotPotV3Fund.json'
import { Contract, Wallet } from 'ethers'
import { IHotPotV3Fund } from '../../typechain'

export default function fundAtAddress(address: string, wallet: Wallet): IHotPotV3Fund {
  return new Contract(address, FUND_ABI, wallet) as IHotPotV3Fund
}
