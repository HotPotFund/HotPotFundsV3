import { BigNumber, constants, Contract } from 'ethers'
import { Fixture } from 'ethereum-waffle'
import { waffle } from 'hardhat'
import { expect } from './shared/expect'

import {
    INIT_FOR_TEST_TOKEN_AMOUNT_18,
    INIT_FOR_TEST_TOKEN_AMOUNT_6,
    INIT_FOR_TEST_WETH_AMOUNT,
    mintAndDepositHotPotFund
} from './shared/fixtures'
import completeFixture, { CompleteFixture } from './shared/completeFixture'
import { createFund, createUniV3PoolAndInit } from './shared/createUtils'
import { IHotPotV3Fund } from '../typechain'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { expandTo18Decimals, expandTo6Decimals, snapshotGasCost } from './shared/utils'
import { getMaxTick, getMinTick } from './shared/ticks'
import { encodePath } from './shared/path'

const INIT_DEPOSIT_AMOUNT_18 = expandTo18Decimals(1e3);
const INIT_DEPOSIT_AMOUNT_6 = expandTo6Decimals(1e3);
const INIT_HARVEST_AMOUNT_18 = expandTo18Decimals(25);
const INIT_HARVEST_AMOUNT_6 = expandTo6Decimals(25);


describe('HotPotV3FundController', () => {
    const wallets = waffle.provider.getWallets()
    const [manager, depositor, other] = wallets;
    const governance = other;

    let fixture: CompleteFixture;
    let hotPotFund: IHotPotV3Fund;
    let investToken: Contract;
    let token0: Contract;
    let token1: Contract;
    let token2: Contract;
    let INIT_DEPOSIT_AMOUNT: BigNumber;
    let INIT_HARVEST_AMOUNT: BigNumber;
    let loadFixture: ReturnType<typeof waffle.createFixtureLoader>


    const controllerFixture: Fixture<CompleteFixture> = async (wallets, provider) => {
        const fixture = await completeFixture(wallets, provider, governance)

        //transfer tokens to tester
        for (const token of fixture.tokens) {
            await token.connect(manager).transfer(depositor.address, await token.decimals() == 18 ? INIT_FOR_TEST_TOKEN_AMOUNT_18 : INIT_FOR_TEST_TOKEN_AMOUNT_6)
        }
        await fixture.weth9.connect(manager).deposit({value: INIT_FOR_TEST_WETH_AMOUNT})
        await fixture.weth9.connect(depositor).deposit({value: INIT_FOR_TEST_WETH_AMOUNT})

        fixture.tokens = fixture.tokens.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1))
        investToken = fixture.tokens[0];
        token0 = fixture.tokens[1];
        token1 = fixture.tokens[2];
        token2 = fixture.tokens[3];

        //t0+t1 pool
        await createUniV3PoolAndInit(manager, fixture, token0, token1);
        //fund+t0 pool
        await createUniV3PoolAndInit(manager, fixture, investToken, token0);
        //fund+t1 pool
        await createUniV3PoolAndInit(manager, fixture, investToken, token1);
        //fund+hpt pool
        await createUniV3PoolAndInit(manager, fixture, investToken, fixture.tokenHotPot);
        //weth9+hpt pool
        await createUniV3PoolAndInit(manager, fixture, fixture.weth9, fixture.tokenHotPot);

        INIT_DEPOSIT_AMOUNT = await investToken.decimals() == 18 ? INIT_DEPOSIT_AMOUNT_18 : INIT_DEPOSIT_AMOUNT_6;
        INIT_HARVEST_AMOUNT = await investToken.decimals() == 18 ? INIT_HARVEST_AMOUNT_18 : INIT_HARVEST_AMOUNT_6;

        await fixture.controller.connect(governance).setVerifiedToken(investToken.address, true);
        hotPotFund = await createFund(manager, investToken, "abc", 0, 0, 15, fixture.factory);

        await mintAndDepositHotPotFund(hotPotFund, investToken, depositor, INIT_DEPOSIT_AMOUNT);

        return fixture
    }

    before(async () => {
        loadFixture = await waffle.createFixtureLoader(wallets)
    });

    beforeEach(async () => {
        fixture = await loadFixture(controllerFixture);
    });

    it('bytecode size', async () => {
        expect(((await fixture.controller.provider.getCode(fixture.controller.address)).length - 2) / 2).to.matchSnapshot()
    })

    it('constructor initializes', async () => {
        await expect(await fixture.controller.uniV3Factory()).to.eq(fixture.uniV3Factory.address);
        await expect(await fixture.controller.uniV3Router()).to.eq(fixture.uniV3Router.address);
        await expect(await fixture.controller.hotpot()).to.eq(fixture.tokenHotPot.address);
        await expect(await fixture.controller.WETH9()).to.eq(fixture.weth9.address);
        await expect(await fixture.controller.governance()).to.eq(governance.address);
        await expect(await fixture.controller.maxPriceImpact()).to.eq(100);
        await expect(await fixture.controller.maxSqrtSlippage()).to.eq(9974);
    });

    it('setGovernance', async () => {
        //Non-Governance operation
        await expect(fixture.controller.connect(depositor).setGovernance(manager.address))
          .to.be.reverted;//With("Only called by Governance.");

        await expect(fixture.controller.connect(governance).setGovernance(depositor.address))
          .to.emit(fixture.controller, "SetGovernance")
          .withArgs(depositor.address);
        await expect(await fixture.controller.governance()).to.eq(depositor.address);

        await expect(fixture.controller.connect(depositor).setGovernance(governance.address))
          .to.emit(fixture.controller, "SetGovernance")
          .withArgs(governance.address);
        await expect(await fixture.controller.governance()).to.eq(governance.address);
    });

    describe('setVerifiedToken',  () => {
        it("fails if it's not a action called by governance", async () => {
            const token = fixture.tokens[4];

            await expect(fixture.controller.connect(depositor).setVerifiedToken(token.address, false))
              .to.be.reverted;//With("Only called by Governance.")
        });

        it("works if it's a action called by governance", async()=>{
            const token = fixture.tokens[4];

            await expect(fixture.controller.connect(governance).setVerifiedToken(token.address, false))
              .to.emit(fixture.controller, "ChangeVerifiedToken")
              .withArgs(token.address, false);
            await expect(await fixture.controller.verifiedToken(token.address)).to.eq(false);

            await expect(fixture.controller.connect(governance).setVerifiedToken(token.address, true))
              .to.emit(fixture.controller, "ChangeVerifiedToken")
              .withArgs(token.address, true);
            await expect(await fixture.controller.verifiedToken(token.address)).to.eq(true);
        })
    });

    describe('#setHarvestPath', ()=>{
        it("fail if it's not a action called by governance", async () => {
            //fund->HPT
            let path = encodePath([investToken.address, fixture.tokenHotPot.address], [FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(depositor).setHarvestPath(investToken.address, path))
              .to.be.reverted;//With("Only called by Governance.");
        });

        it("fail if finally no weth9->hpt was used", async () => {
            //fundToken->t0
            let path = encodePath([investToken.address, token0.address], [FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(governance).setHarvestPath(investToken.address, path)).to.be.reverted;
            //fundToken->HPT
            path = encodePath([investToken.address, fixture.tokenHotPot.address], [FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(governance).setHarvestPath(investToken.address, path)).to.be.reverted;
        });

        it("fail if pool isn't exist", async () => {
            //fundToken->weth9->hpt
            let path = encodePath([investToken.address, fixture.weth9.address, fixture.tokenHotPot.address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(governance).setHarvestPath(investToken.address, path)).to.be.reverted;
        })

        it('works if finally used weth9->hpt', async () => {
            //fundToken->HPT->weth9->HPT
            const path = encodePath([investToken.address, fixture.tokenHotPot.address, fixture.weth9.address, fixture.tokenHotPot.address],
              [FeeAmount.MEDIUM, FeeAmount.MEDIUM, FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(governance).setHarvestPath(investToken.address, path))
              .to.emit(fixture.controller, "SetHarvestPath")
              .withArgs(investToken.address, path);
            expect(await fixture.controller.harvestPath(investToken.address)).to.eq(path);
        });
    })

    describe('#setMaxSqrtSlippage', () => {
        it("fail if it's not a action called by governance", async () => {
            await expect(fixture.controller.connect(depositor).setMaxSqrtSlippage(30))
              .to.be.revertedWith("OGC");
        });

        it("fail if slippage > 10000", async () => {
            await expect(fixture.controller.connect(governance).setMaxSqrtSlippage(10001))
              .to.be.revertedWith("SSS");
        });
        it("works if slippage <= 10000", async () => {
            await expect(fixture.controller.connect(governance).setMaxSqrtSlippage(0))
              .to.emit(fixture.controller, "SetMaxSqrtSlippage").withArgs(0);
            await expect(await fixture.controller.maxSqrtSlippage()).to.eq(0);
            await expect(fixture.controller.connect(governance).setMaxSqrtSlippage(30))
              .to.emit(fixture.controller, "SetMaxSqrtSlippage").withArgs(30);
            await expect(await fixture.controller.maxSqrtSlippage()).to.eq(30);
            await expect(fixture.controller.connect(governance).setMaxSqrtSlippage(100))
              .to.emit(fixture.controller, "SetMaxSqrtSlippage").withArgs(100);
            await expect(await fixture.controller.maxSqrtSlippage()).to.eq(100);
        });
    })

    describe('#setMaxPriceImpact', () => {
        it("fail if it's not a action called by governance", async () => {
            await expect(fixture.controller.connect(depositor).setMaxPriceImpact(30))
              .to.be.revertedWith("OGC");
        });

        it("fail if slippage > 10000", async () => {
            await expect(fixture.controller.connect(governance).setMaxPriceImpact(10001))
              .to.be.revertedWith("SPI");
        });
        it("works if slippage <= 10000", async () => {
            await expect(fixture.controller.connect(governance).setMaxPriceImpact(0))
              .to.emit(fixture.controller, "SetMaxPriceImpact").withArgs(0);
            await expect(await fixture.controller.maxPriceImpact()).to.eq(0);
            await expect(fixture.controller.connect(governance).setMaxPriceImpact(200))
              .to.emit(fixture.controller, "SetMaxPriceImpact").withArgs(200);
            await expect(await fixture.controller.maxPriceImpact()).to.eq(200);
            await expect(fixture.controller.connect(governance).setMaxPriceImpact(300))
              .to.emit(fixture.controller, "SetMaxPriceImpact").withArgs(300);
            await expect(await fixture.controller.maxPriceImpact()).to.eq(300);
        });
    })

    describe("#setDepositDeadline", () => {
        it("fail if it's not a action called by manager", async () => {
            await expect(fixture.controller.connect(depositor).setDepositDeadline(
              hotPotFund.address,
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.be.reverted
        })

        it("works if it's a action called by manager", async () => {
            let deadline = Math.round(new Date().getTime() / 1e3 + 12000)
            await expect(fixture.controller.connect(manager).setDepositDeadline(
              hotPotFund.address,
              deadline
            )).to.emit(hotPotFund, 'SetDeadline')
              .withArgs(deadline)
        })
    })

    describe('#setPath', ()=>{
        beforeEach("setVerifiedToken", async()=>{
            await fixture.controller.connect(governance).setVerifiedToken(token0.address, true);
            await fixture.controller.connect(governance).setVerifiedToken(token1.address, true);
        })

        it("fail if it's not a action called by manager", async () => {
            const distToken = token0;
            await expect(fixture.controller.connect(depositor).setPath(
              hotPotFund.address,
              distToken.address,
              encodePath([investToken.address, distToken.address], [FeeAmount.MEDIUM])
            )).to.be.reverted;
        });

        it("fails if path in/out error", async () => {
            // for buyPath, no firstIn fundToken
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([token1.address, token0.address],[FeeAmount.MEDIUM])
            )).to.be.reverted;
            // for buyPath, no lastOut distToken
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([investToken.address, token1.address],[FeeAmount.MEDIUM])
            )).to.be.reverted;

            // for sellPath, no firstIn distToken
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([token1.address, investToken.address], [FeeAmount.MEDIUM])
            )).to.be.reverted;
            // for sellPath, no lastOut fundToken
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([token0.address, token1.address], [FeeAmount.MEDIUM])
            )).to.be.reverted;
        });

        it("works if it's a action called by manager", async () => {
            //singlePath
            let path = encodePath([investToken.address, token0.address], [FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              path
            ))
            .to.emit(hotPotFund, "SetPath")
            .withArgs(token0.address, path);

            //multiPath
            path = encodePath([investToken.address, token1.address, token0.address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              path
            ))
            .to.emit(hotPotFund, "SetPath")
            .withArgs(token0.address, path);
        });

        it("fails if pool isn't exits", async () =>{
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([token0.address, token2.address, investToken.address],
                [FeeAmount.MEDIUM, FeeAmount.MEDIUM])
            )).to.be.reverted;
        });

        it("fails if token isn't verified", async () =>{
            await fixture.controller.connect(governance).setVerifiedToken(fixture.tokens[3].address, false);
            //in singlePath
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              fixture.tokens[3].address,
              encodePath([investToken.address, fixture.tokens[3].address],
                [FeeAmount.MEDIUM])
            )).to.be.reverted;

            //in multiPath
            await expect(fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([investToken.address, fixture.tokens[3].address, token0.address],
                [FeeAmount.MEDIUM, FeeAmount.MEDIUM])
            )).to.be.reverted;
        });
    })

    describe('#init', ()=>{
        it("fail if it's not a action called by manager", async () => {
            await expect(fixture.controller.connect(depositor).init(
              hotPotFund.address,
              token0.address,
              token1.address,
              FeeAmount.MEDIUM,
              getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              0,
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.be.reverted;
        });

        it("fail if the deadline expires", async () => {
            await expect(fixture.controller.connect(manager).init(
              hotPotFund.address,
              token0.address,
              token1.address,
              FeeAmount.MEDIUM,
              getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              0,
              Math.floor(new Date().getTime() / 1e3 - 12000)
            )).to.be.revertedWith("CDL");
        });

        it("works if it's a action called by manager", async () => {
            await expect(fixture.controller.connect(manager).init(
              hotPotFund.address,
              token0.address,
              token1.address,
              FeeAmount.MEDIUM,
              getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              0,
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.not.be.reverted;
        });
    });

    describe('#add', () => {
        beforeEach('setVerifiedToken', async () => {
            await fixture.controller.connect(governance).setVerifiedToken(token0.address, true)
            await fixture.controller.connect(governance).setVerifiedToken(token1.address, true)

            // init position
            await fixture.controller.connect(manager).init(
              hotPotFund.address,
              token0.address,
              token1.address,
              FeeAmount.MEDIUM,
              getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              0,
              Math.round(new Date().getTime() / 1e3 + 12000))

            //token0 swapPath
            await fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([investToken.address, token0.address], [FeeAmount.MEDIUM])
            );

            //token1 swapPath
            await fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token1.address,
              encodePath([investToken.address, token1.address], [FeeAmount.MEDIUM])
            );

            // change init price impact
            await expect(fixture.controller.connect(governance).setMaxPriceImpact(5000))
              .to.emit(fixture.controller, "SetMaxPriceImpact").withArgs(5000);
        })

        it("fail if it's not a action called by manager", async () => {
            await expect(fixture.controller.connect(depositor).add(
              hotPotFund.address, 0, 0, INIT_DEPOSIT_AMOUNT, false,
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.be.reverted;
        });

        it("fail if the deadline expires", async () => {
            await expect(fixture.controller.connect(manager).add(
              hotPotFund.address, 0, 0, INIT_DEPOSIT_AMOUNT, false,
              Math.floor(new Date().getTime() / 1e3 - 12000)
            )).to.be.revertedWith("CDL");
        });

        it("works if it's a action called by manager", async () => {
            await expect(fixture.controller.connect(manager).add(
              hotPotFund.address, 0, 0, INIT_DEPOSIT_AMOUNT, false,
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.not.be.reverted;
        });
    });

    describe('#sub', ()=>{
        beforeEach('setVerifiedToken', async () => {
            await fixture.controller.connect(governance).setVerifiedToken(token0.address, true)
            await fixture.controller.connect(governance).setVerifiedToken(token1.address, true)

            // init position
            await fixture.controller.connect(manager).init(
              hotPotFund.address,
              token0.address,
              token1.address,
              FeeAmount.MEDIUM,
              getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              0,
              Math.round(new Date().getTime() / 1e3 + 12000))

            //token0 swapPath
            await fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([investToken.address, token0.address], [FeeAmount.MEDIUM])
            );

            //token1 swapPath
            await fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token1.address,
              encodePath([investToken.address, token1.address], [FeeAmount.MEDIUM])
            );

            // change init price impact
            await expect(fixture.controller.connect(governance).setMaxPriceImpact(5000))
              .to.emit(fixture.controller, "SetMaxPriceImpact").withArgs(5000);

            //add position
            await expect(fixture.controller.connect(manager).add(
              hotPotFund.address, 0, 0, INIT_DEPOSIT_AMOUNT, false,
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.not.be.reverted;
        })

        it("fail if it's not a action called by manager", async () => {
            await expect(fixture.controller.connect(depositor).sub(
              hotPotFund.address, 0, 0, BigNumber.from(100).mul(BigNumber.from(2).pow(128)),
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.be.reverted;
        });

        it("fail if the deadline expires", async () => {
            await expect(fixture.controller.connect(manager).sub(
              hotPotFund.address, 0, 0, BigNumber.from(100).mul(BigNumber.from(2).pow(128)),
              Math.floor(new Date().getTime() / 1e3 - 12000)
            )).to.be.revertedWith("CDL");
        });

        it("works if it's a action called by manager", async () => {
            await expect(fixture.controller.connect(manager).sub(
              hotPotFund.address, 0, 0, BigNumber.from(100).mul(BigNumber.from(2).pow(128)),
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.not.be.reverted;
        });
    });

    describe('#move', ()=>{
        beforeEach('setVerifiedToken', async () => {
            await fixture.controller.connect(governance).setVerifiedToken(token0.address, true)
            await fixture.controller.connect(governance).setVerifiedToken(token1.address, true)

            // init 2 position
            await fixture.controller.connect(manager).init(
              hotPotFund.address,
              token0.address,
              token1.address,
              FeeAmount.MEDIUM,
              getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
              0,
              Math.round(new Date().getTime() / 1e3 + 12000))
            await fixture.controller.connect(manager).init(
              hotPotFund.address,
              token0.address,
              token1.address,
              FeeAmount.MEDIUM,
              getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]) + TICK_SPACINGS[FeeAmount.MEDIUM],
              getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]) - TICK_SPACINGS[FeeAmount.MEDIUM],
              0,
              Math.round(new Date().getTime() / 1e3 + 12000))

            //token0 swapPath
            await fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token0.address,
              encodePath([investToken.address, token0.address], [FeeAmount.MEDIUM])
            );

            //token1 swapPath
            await fixture.controller.connect(manager).setPath(
              hotPotFund.address,
              token1.address,
              encodePath([investToken.address, token1.address], [FeeAmount.MEDIUM])
            );

            // change init price impact
            await expect(fixture.controller.connect(governance).setMaxPriceImpact(5000))
              .to.emit(fixture.controller, "SetMaxPriceImpact").withArgs(5000);

            //add 2 position
            await expect(fixture.controller.connect(manager).add(
              hotPotFund.address, 0, 0, INIT_DEPOSIT_AMOUNT.div(2), false,
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.not.be.reverted;
            await expect(fixture.controller.connect(manager).add(
              hotPotFund.address, 0, 0, INIT_DEPOSIT_AMOUNT.div(2), false,
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.not.be.reverted;
        })

        it("fail if it's not a action called by manager", async () => {
            await expect(fixture.controller.connect(depositor).sub(
              hotPotFund.address, 0, 0, BigNumber.from(100).mul(BigNumber.from(2).pow(128)),
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.be.reverted;
        });

        it("fail if the deadline expires", async () => {
            await expect(fixture.controller.connect(manager).sub(
              hotPotFund.address, 0, 0, BigNumber.from(100).mul(BigNumber.from(2).pow(128)),
              Math.floor(new Date().getTime() / 1e3 - 12000)
            )).to.be.revertedWith("CDL");
        });

        it("works if it's a action called by manager", async () => {
            await expect(fixture.controller.connect(manager).sub(
              hotPotFund.address, 0, 0, BigNumber.from(100).mul(BigNumber.from(2).pow(128)),
              Math.round(new Date().getTime() / 1e3 + 12000)
            )).to.not.be.reverted;
        });
    });

    describe('#multiCall', ()=>{
        //setVerifiedToken
        it("fails if it's not a action called by governance", async () => {
            const data = [
                fixture.controller.interface.encodeFunctionData("setVerifiedToken",
                  [fixture.tokens[4].address, false]
                ),
                fixture.controller.interface.encodeFunctionData("setVerifiedToken",
                  [fixture.tokens[4].address, true]
                ),
            ]
            await expect(fixture.controller.connect(depositor).multicall(data)).to.be.reverted;
        });

        it("works if it's a action called by governance", async()=>{
            const data = [
                fixture.controller.interface.encodeFunctionData("setVerifiedToken",
                  [fixture.tokens[4].address, false]
                ),
                fixture.controller.interface.encodeFunctionData("setVerifiedToken",
                  [fixture.tokens[4].address, true]
                ),
            ]
            const tx = fixture.controller.connect(governance).multicall(data);
            await expect(tx).to.not.be.reverted;
            //gas
            await snapshotGasCost(tx);
        })

        it("fail if it's not a action called by manager", async () => {
            const data = [
                fixture.controller.interface.encodeFunctionData("init",
                  [hotPotFund.address, token0.address, token1.address,
                      FeeAmount.MEDIUM,
                      getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                      getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]), 0,
                      Math.round(new Date().getTime() / 1e3 + 12000)]
                ),
                fixture.controller.interface.encodeFunctionData("init",
                  [hotPotFund.address, token0.address, token1.address,
                      FeeAmount.MEDIUM,
                      getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]) + TICK_SPACINGS[FeeAmount.MEDIUM],
                      getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]) - TICK_SPACINGS[FeeAmount.MEDIUM], 0,
                      Math.round(new Date().getTime() / 1e3 + 12000)]
                ),
            ]
            await expect(fixture.controller.connect(depositor).multicall(data)).to.be.reverted;
        });

        it("works if it's a action called by manager", async () => {
            const data = [
                fixture.controller.interface.encodeFunctionData("init",
                  [hotPotFund.address, token0.address, token1.address,
                      FeeAmount.MEDIUM,
                      getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                      getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]), 0,
                      Math.round(new Date().getTime() / 1e3 + 12000)]
                ),
                fixture.controller.interface.encodeFunctionData("init",
                  [hotPotFund.address, token0.address, token1.address,
                      FeeAmount.MEDIUM,
                      getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]) + TICK_SPACINGS[FeeAmount.MEDIUM],
                      getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]) - TICK_SPACINGS[FeeAmount.MEDIUM], 0,
                      Math.round(new Date().getTime() / 1e3 + 12000)]
                ),
            ]
            await expect(fixture.controller.connect(manager).multicall(data)).to.not.be.reverted;
        });
    })

    describe('#harvest', ()=>{
        it("fails if the balance is insufficient", async() => {
            await expect(fixture.controller.harvest(investToken.address, 0))
              .to.be.reverted;
            await expect(fixture.controller.harvest(investToken.address, INIT_HARVEST_AMOUNT))
              .to.be.reverted;
        });

        it("fail if the slippage is too big", async() => {
            //transfer test token to controller
            await expect(investToken.connect(manager).transfer(fixture.controller.address, INIT_HARVEST_AMOUNT))
              .to.not.be.reverted;
            await expect(await investToken.balanceOf(fixture.controller.address))
              .to.eq(INIT_HARVEST_AMOUNT);

            //create fund+weth9 pool
            await createUniV3PoolAndInit(manager, fixture, investToken, fixture.weth9);

            //set token -> HPT path
            const path = encodePath([investToken.address, fixture.weth9.address, fixture.tokenHotPot.address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(governance).setHarvestPath(investToken.address, path))
              .to.not.be.reverted;

            //mock too large slippage harvest
            await fixture.weth9.connect(depositor).transfer(fixture.testSlippage.address, INIT_FOR_TEST_WETH_AMOUNT);
            await expect(fixture.testSlippage.harvest(
              investToken.address, INIT_HARVEST_AMOUNT, INIT_FOR_TEST_WETH_AMOUNT.div(2),
              fixture.weth9.address, encodePath([fixture.weth9.address, fixture.tokenHotPot.address], [FeeAmount.MEDIUM]))
            ).to.be.revertedWith("VS");
        });

        it("works if there is a balance and path", async() => {
            //transfer test token to controller
            await expect(investToken.connect(manager).transfer(fixture.controller.address, INIT_HARVEST_AMOUNT))
              .to.not.be.reverted;
            await expect(await investToken.balanceOf(fixture.controller.address))
              .to.eq(INIT_HARVEST_AMOUNT);

            //create fund+weth9 pool
            await createUniV3PoolAndInit(manager, fixture, investToken, fixture.weth9);

            //set token -> HPT path
            const path = encodePath([investToken.address, fixture.weth9.address, fixture.tokenHotPot.address], [FeeAmount.MEDIUM, FeeAmount.MEDIUM]);
            await expect(fixture.controller.connect(governance).setHarvestPath(investToken.address, path))
              .to.not.be.reverted;

            const amountOut = await fixture.quoter.callStatic.quoteExactInput(path, INIT_HARVEST_AMOUNT)
            //harvest
            const tx = fixture.controller.harvest(investToken.address, INIT_HARVEST_AMOUNT);
            await expect(tx)
                //burn
                .to.emit(fixture.tokenHotPot, "Transfer")
                .withArgs(fixture.controller.address, constants.AddressZero, amountOut);

            //gas
            await snapshotGasCost(tx);
        });
    })
});
