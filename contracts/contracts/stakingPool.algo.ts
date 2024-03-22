import { Contract } from '@algorandfoundation/tealscript';
// eslint-disable-next-line import/no-cycle
import { PoolTokenPayoutRatio, ValidatorPoolKey, ValidatorRegistry } from './validatorRegistry.algo';
import {
    ALGORAND_ACCOUNT_MIN_BALANCE,
    APPLICATION_BASE_FEE,
    ASSET_HOLDING_FEE,
    MAX_ALGO_PER_POOL,
    MAX_STAKERS_PER_POOL,
    MAX_VALIDATOR_PCT_OF_ONLINE,
    MIN_ALGO_STAKE_PER_POOL,
    SSC_VALUE_BYTES,
    SSC_VALUE_UINT,
} from './constants.algo';

const ALGORAND_STAKING_BLOCK_DELAY = 320; // # of blocks until algorand sees online balance changes in staking
const AVG_BLOCK_TIME_SECS = 28; // in tenths - 28 = 2.8

export type StakedInfo = {
    Account: Address;
    Balance: uint64;
    TotalRewarded: uint64;
    RewardTokenBalance: uint64;
    EntryTime: uint64;
};

// eslint-disable-next-line no-unused-vars
/**
 * StakingPool contract has a new instance deployed per staking pool added by any validator.  A single instance
 * is initially immutably deployed, and the ID of that instance is used as a construction parameter in the immutable
 * instance of the master ValidatoryRegistry contract.  It then uses that StakingPool instance as a 'factory template'
 * for subsequent pool creations - using the on-chain bytecode of that deployed instance to create a new identical
 * instance.
 *
 * Each instance is explicitly 'linked' to the validator master via its creation parameters.  The validator master
 * contract only allows calls from staking pool contract instances that match data that only the validator master
 * authoritatively has (validator id X, pool Y - has to come from contract address of that pool).  Calls the pools
 * validate coming from the validator are only allowed if it matches the validator id it was created with.
 */
export class StakingPool extends Contract {
    programVersion = 10;

    // When created, we track our creating validator contract so that only this contract can call us.  Independent
    // copies of this contract could be created but only the 'official' validator contract would be considered valid
    // and official.  Calls from these pools back to the validator contract are also validated, ensuring the pool
    // calling the validator is one of the pools it created.
    CreatingValidatorContractAppID = GlobalStateKey<uint64>({ key: 'creatorApp' });

    // The 'id' of the validator our pool belongs to
    ValidatorID = GlobalStateKey<uint64>({ key: 'validatorID' });

    // The pool ID we were assigned by the validator contract - sequential id per validator
    PoolID = GlobalStateKey<uint64>({ key: 'poolID' });

    NumStakers = GlobalStateKey<uint64>({ key: 'numStakers' });

    TotalAlgoStaked = GlobalStateKey<uint64>({ key: 'staked' });

    MinEntryStake = GlobalStateKey<uint64>({ key: 'minEntryStake' });

    MaxStakeAllowed = GlobalStateKey<uint64>({ key: 'maxStake' });

    // Last timestamp of a payout - used to ensure payout call isn't cheated and called prior to agreed upon schedule
    LastPayout = GlobalStateKey<uint64>({ key: 'lastPayout' });

    // Version of algod this pool is connected to - should be updated regularly
    AlgodVer = GlobalStateKey<bytes>({ key: 'algodVer' });

    // Our 'ledger' of stakers, tracking each staker account and its balance, total rewards, and last entry time
    Stakers = BoxKey<StaticArray<StakedInfo, typeof MAX_STAKERS_PER_POOL>>({ key: 'stakers' });

    NFDRegistryAppID = TemplateVar<uint64>();

    FeeSinkAddr = TemplateVar<Address>();

    /**
     * Initialize the staking pool w/ owner and manager, but can only be created by the validator contract.
     * @param creatingContractID - id of contract that constructed us - the validator application (single global instance)
     * @param validatorID - id of validator we're a staking pool of
     * @param poolID - which pool id are we
     * @param minEntryStake - minimum amount to be in pool, but also minimum amount balance can't go below (without removing all!)
     * @param maxStakeAllowed - maximum algo allowed in this staking pool
     */
    createApplication(
        creatingContractID: uint64,
        validatorID: uint64,
        poolID: uint64,
        minEntryStake: uint64,
        maxStakeAllowed: uint64
    ): void {
        if (creatingContractID === 0) {
            // this is likely initial template setup - everything should basically be zero...
            assert(creatingContractID === 0);
            assert(validatorID === 0);
            assert(poolID === 0);
        } else {
            assert(creatingContractID !== 0);
            assert(validatorID !== 0);
            assert(poolID !== 0);
        }
        assert(minEntryStake >= MIN_ALGO_STAKE_PER_POOL);
        assert(maxStakeAllowed <= MAX_ALGO_PER_POOL); // this should have already been checked by validator but... still
        this.CreatingValidatorContractAppID.value = creatingContractID;
        this.ValidatorID.value = validatorID;
        this.PoolID.value = poolID;
        this.NumStakers.value = 0;
        this.TotalAlgoStaked.value = 0;
        this.MinEntryStake.value = minEntryStake;
        this.MaxStakeAllowed.value = maxStakeAllowed;
        this.LastPayout.value = globals.latestTimestamp; // set 'last payout' to init time of pool to establish baseline
    }

    /**
     * gas is a dummy no-op call that can be used to pool-up resource references and opcode cost
     */
    gas(): void {}

    private minBalanceForAccount(
        contracts: uint64,
        extraPages: uint64,
        assets: uint64,
        localInts: uint64,
        localBytes: uint64,
        globalInts: uint64,
        globalBytes: uint64
    ): uint64 {
        let minBal = ALGORAND_ACCOUNT_MIN_BALANCE;
        minBal += contracts * APPLICATION_BASE_FEE;
        minBal += extraPages * APPLICATION_BASE_FEE;
        minBal += assets * ASSET_HOLDING_FEE;
        minBal += localInts * SSC_VALUE_UINT;
        minBal += globalInts * SSC_VALUE_UINT;
        minBal += localBytes * SSC_VALUE_BYTES;
        minBal += globalBytes * SSC_VALUE_BYTES;
        return minBal;
    }

    private costForBoxStorage(totalNumBytes: uint64): uint64 {
        const SCBOX_PERBOX = 2500;
        const SCBOX_PERBYTE = 400;

        return SCBOX_PERBOX + totalNumBytes * SCBOX_PERBYTE;
    }

    /**
     * Called after we're created and then funded so we can create our large stakers ledger storage
     * Caller has to get MBR amounts from ValidatorRegistry to know how much to fund us to cover the box storage cost
     * If this is pool 1 AND the validator has specified a reward token, opt-in to that token
     * so that the validator can seed the pool with future rewards of that token.
     * @param mbrPayment payment from caller which covers mbr increase of new staking pools' storage
     */
    initStorage(mbrPayment: PayTxn): void {
        assert(!this.Stakers.exists, 'staking pool already initialized');

        // Get the config of our validator to determine if we issue reward tokens
        const validatorConfig = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorConfig>({
            applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
            methodArgs: [this.ValidatorID.value],
        });
        const isTokenEligible = validatorConfig.RewardTokenID !== 0;
        const extraMBR = isTokenEligible && this.PoolID.value === 1 ? ASSET_HOLDING_FEE : 0;
        const PoolInitMbr =
            ALGORAND_ACCOUNT_MIN_BALANCE +
            extraMBR +
            this.costForBoxStorage(7 /* 'stakers' name */ + len<StakedInfo>() * MAX_STAKERS_PER_POOL);

        // the pay transaction must exactly match our MBR requirement.
        verifyPayTxn(mbrPayment, { amount: PoolInitMbr });
        this.Stakers.create();

        if (isTokenEligible && this.PoolID.value === 1) {
            // opt ourselves in to the reward token if we're pool 1
            sendAssetTransfer({
                xferAsset: AssetID.fromUint64(validatorConfig.RewardTokenID),
                assetReceiver: this.app.address,
                assetAmount: 0,
            });
        }
    }

    /**
     * Adds stake to the given account.
     * Can ONLY be called by the validator contract that created us
     * Must receive payment from the validator contract for amount being staked.
     *
     * @param {PayTxn} stakedAmountPayment prior payment coming from validator contract to us on behalf of staker.
     * @param {Address} staker - The account adding new stake
     * @throws {Error} - Throws an error if the staking pool is full.
     * @returns {uint64} new 'entry time' in seconds of stake add.
     */
    addStake(stakedAmountPayment: PayTxn, staker: Address): uint64 {
        assert(this.Stakers.exists);

        // The contract account calling us has to be our creating validator contract
        assert(this.txn.sender === AppID.fromUint64(this.CreatingValidatorContractAppID.value).address);
        assert(staker !== globals.zeroAddress);

        // Now, is the required amount actually being paid to US (this contract account - the staking pool)
        // Sender doesn't matter - but it 'technically' should be coming from the Validator contract address
        verifyPayTxn(stakedAmountPayment, {
            sender: AppID.fromUint64(this.CreatingValidatorContractAppID.value).address,
            receiver: this.app.address,
            amount: stakedAmountPayment.amount,
        });
        assert(
            stakedAmountPayment.amount + this.TotalAlgoStaked.value <= this.MaxStakeAllowed.value,
            'adding this stake amount will exceed the max allowed in this pool'
        );
        // See if the account staking is already in our ledger of Stakers - if so, they're just adding to their stake
        // track first empty slot as we go along as well.
        const entryTime = this.getEntryTime();
        let firstEmpty = 0;

        // firstEmpty should represent 1-based index to first empty slot we find - 0 means none were found
        for (let i = 0; i < this.Stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 300) {
                increaseOpcodeBudget();
            }
            const cmpStaker = clone(this.Stakers.value[i]);
            if (cmpStaker.Account === staker) {
                cmpStaker.Balance += stakedAmountPayment.amount;
                cmpStaker.EntryTime = entryTime;

                // Update the box w/ the new data
                this.Stakers.value[i] = cmpStaker;

                this.TotalAlgoStaked.value += stakedAmountPayment.amount;
                return entryTime;
            }
            if (cmpStaker.Account === globals.zeroAddress) {
                firstEmpty = i + 1;
                break;
            }
        }

        if (firstEmpty === 0) {
            // nothing was found - pool is full and this staker can't fit
            throw Error('Staking pool full');
        }
        // This is a new staker to the pool, so first ensure they're adding required minimum, then
        // initialize slot and add to the stakers.
        // our caller will see stakers increase in state and increase in their state as well.
        assert(stakedAmountPayment.amount >= this.MinEntryStake.value, 'must stake at least the minimum for this pool');

        assert(this.Stakers.value[firstEmpty - 1].Account === globals.zeroAddress);
        this.Stakers.value[firstEmpty - 1] = {
            Account: staker,
            Balance: stakedAmountPayment.amount,
            TotalRewarded: 0,
            RewardTokenBalance: 0,
            EntryTime: entryTime,
        };
        this.NumStakers.value += 1;
        this.TotalAlgoStaked.value += stakedAmountPayment.amount;
        return entryTime;
    }

    /**
     * Removes stake on behalf of caller (removing own stake).  If any token rewards exist, those are always sent in
     * full. Also notifies the validator contract for this pools validator of the staker / balance changes.
     *
     * @param {uint64} amountToUnstake - The amount of stake to be removed.  Specify 0 to remove all stake.
     * @throws {Error} If the account has insufficient balance or if the account is not found.
     */
    removeStake(amountToUnstake: uint64): void {
        // We want to preserve the sanctity that the ONLY account that can call us is the staking account
        // It makes it a bit awkward this way to update the state in the validator, but it's safer
        // account calling us has to be account removing stake
        const staker = this.txn.sender;

        for (let i = 0; i < this.Stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 300) {
                increaseOpcodeBudget();
            }
            const cmpStaker = clone(this.Stakers.value[i]);
            if (cmpStaker.Account === staker) {
                if (amountToUnstake === 0) {
                    // specifying 0 for unstake amount is requesting to UNSTAKE ALL
                    amountToUnstake = cmpStaker.Balance;
                }
                if (cmpStaker.Balance < amountToUnstake) {
                    throw Error('Insufficient balance');
                }
                cmpStaker.Balance -= amountToUnstake;
                this.TotalAlgoStaked.value -= amountToUnstake;

                let amountRewardTokenRemoved = 0;
                if (cmpStaker.RewardTokenBalance > 0) {
                    // If and only if this is pool 1 (where the reward token is held - then we can pay it out)
                    if (this.PoolID.value === 1) {
                        const validatorConfig = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorConfig>({
                            applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
                            methodArgs: [this.ValidatorID.value],
                        });

                        // ---------
                        // SEND THE REWARD TOKEN NOW - it's in our pool
                        // ---------
                        sendAssetTransfer({
                            xferAsset: AssetID.fromUint64(validatorConfig.RewardTokenID),
                            assetReceiver: staker,
                            assetAmount: cmpStaker.RewardTokenBalance,
                        });
                        amountRewardTokenRemoved = cmpStaker.RewardTokenBalance;
                        cmpStaker.RewardTokenBalance = 0;
                    } else {
                        // If we're in different pool, then we set amountRewardTokenRemoved to amount of reward token to remove
                        // but the stakeRemoved call to the validator will see that a pool other than 1 called it, and
                        // then issues call to pool 1 to do the token payout via 'payTokenReward' method in our contract
                        amountRewardTokenRemoved = cmpStaker.RewardTokenBalance;
                        cmpStaker.RewardTokenBalance = 0;
                    }
                }

                // don't let them reduce their balance below the MinEntryStake UNLESS they're removing it all!
                assert(
                    cmpStaker.Balance === 0 || cmpStaker.Balance >= this.MinEntryStake.value,
                    'cannot reduce balance below minimum allowed stake unless all is removed'
                );

                // ---------
                // Pay the staker back
                // ---------
                sendPayment({
                    amount: amountToUnstake,
                    receiver: staker,
                    note: 'unstaked',
                });
                let stakerRemoved = false;
                if (cmpStaker.Balance === 0) {
                    // Staker has been 'removed' - zero out record
                    this.NumStakers.value -= 1;
                    cmpStaker.Account = globals.zeroAddress;
                    cmpStaker.TotalRewarded = 0;
                    cmpStaker.RewardTokenBalance = 0;
                    stakerRemoved = true;
                }
                // Update the box w/ the new staker data
                this.Stakers.value[i] = cmpStaker;

                // Call the validator contract and tell it we're removing stake
                // It'll verify we're a valid staking pool id and update it
                // stakeRemoved(poolKey: ValidatorPoolKey, staker: Address, amountRemoved: uint64, rewardRemoved: uint64, stakerRemoved: boolean): void
                sendMethodCall<typeof ValidatorRegistry.prototype.stakeRemoved>({
                    applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
                    methodArgs: [
                        { ID: this.ValidatorID.value, PoolID: this.PoolID.value, PoolAppID: this.app.id },
                        staker,
                        amountToUnstake,
                        amountRewardTokenRemoved,
                        stakerRemoved,
                    ],
                });
                return;
            }
        }
        throw Error('Account not found');
    }

    /**
     * Claims all the available reward tokens a staker has available, sending their entire balance to the staker from
     * pool 1 (either directly, or via validator->pool1 to pay it out)
     * Also notifies the validator contract for this pools validator of the staker / balance changes.
     */
    claimTokens(): void {
        // We want to preserve the sanctity that the ONLY account that can call us is the staking account
        // It makes it a bit awkward this way to update the state in the validator, but it's safer
        // account calling us has to be account removing stake
        const staker = this.txn.sender;

        for (let i = 0; i < this.Stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 300) {
                increaseOpcodeBudget();
            }
            const cmpStaker = clone(this.Stakers.value[i]);
            if (cmpStaker.Account === staker) {
                if (cmpStaker.RewardTokenBalance === 0) {
                    return;
                }
                let amountRewardTokenRemoved = 0;
                // If and only if this is pool 1 (where the reward token is held - then we can pay it out)
                if (this.PoolID.value === 1) {
                    const validatorConfig = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorConfig>({
                        applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
                        methodArgs: [this.ValidatorID.value],
                    });
                    // ---------
                    // SEND THE REWARD TOKEN NOW - it's in our pool
                    // ---------
                    sendAssetTransfer({
                        xferAsset: AssetID.fromUint64(validatorConfig.RewardTokenID),
                        assetReceiver: staker,
                        assetAmount: cmpStaker.RewardTokenBalance,
                    });
                    amountRewardTokenRemoved = cmpStaker.RewardTokenBalance;
                    cmpStaker.RewardTokenBalance = 0;
                } else {
                    // If we're in different pool, then we set amountRewardTokenRemoved to amount of reward token to remove
                    // but the stakeRemoved call to the validator will see that a pool other than 1 called it, and
                    // then issues call to pool 1 to do the token payout via 'payTokenReward' method in our contract
                    amountRewardTokenRemoved = cmpStaker.RewardTokenBalance;
                    cmpStaker.RewardTokenBalance = 0;
                }

                // Update the box w/ the new staker balance data (RewardTokenBalance being zeroed)
                this.Stakers.value[i] = cmpStaker;

                // Call the validator contract and tell it we're removing stake
                // It'll verify we're a valid staking pool id and update it
                // stakeRemoved(poolKey: ValidatorPoolKey, staker: Address, amountRemoved: uint64, rewardRemoved: uint64, stakerRemoved: boolean): void
                sendMethodCall<typeof ValidatorRegistry.prototype.stakeRemoved>({
                    applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
                    methodArgs: [
                        { ID: this.ValidatorID.value, PoolID: this.PoolID.value, PoolAppID: this.app.id },
                        staker,
                        0, // no algo removed
                        amountRewardTokenRemoved,
                        false, // staker isn't being removed.
                    ],
                });
                return;
            }
        }
        throw Error('Account not found');
    }

    /**
     * Retrieves the staked information for a given staker.
     *
     * @param {Address} staker - The address of the staker.
     * @returns {StakedInfo} - The staked information for the given staker.
     * @throws {Error} - If the staker's account is not found.
     */
    // @abi.readonly
    getStakerInfo(staker: Address): StakedInfo {
        for (let i = 0; i < this.Stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 200) {
                increaseOpcodeBudget();
            }
            if (this.Stakers.value[i].Account === staker) {
                return this.Stakers.value[i];
            }
        }
        throw Error('Account not found');
    }

    /**
     * [Internal protocol method] Remove a specified amount of 'community token' rewards for a staker.
     * This can ONLY be called by our validator and only if we're pool 1 - with the token.
     * @param staker - the staker account to send rewards to
     * @param rewardToken - ID of reward token (to avoid re-entrancy in calling validator back to get id)
     * @param amountToSend - amount to send the staker (there is significant trust here(!) - also why only validator can call us
     */
    payTokenReward(staker: Address, rewardToken: uint64, amountToSend: uint64): void {
        // account calling us has to be our creating validator contract
        assert(this.txn.sender === AppID.fromUint64(this.CreatingValidatorContractAppID.value).address);
        assert(this.PoolID.value === 1, 'must be pool 1 in order to be called to pay out token rewards');
        assert(rewardToken !== 0, 'can only claim token rewards from validator that has them');

        // Send the reward tokens to the staker
        sendAssetTransfer({
            xferAsset: AssetID.fromUint64(rewardToken),
            assetReceiver: staker,
            assetAmount: amountToSend,
        });
    }

    /**
     * Update the (honor system) algod version for the node associated to this pool.  The node management daemon
     * should compare its current nodes version to the version stored in global state, updating when different.
     * The reti node daemon composes its own version string using format:
     * {major}.{minor}.{build} {branch} [{commit hash}],
     * ie: 3.22.0 rel/stable [6b508975]
     * [ ONLY OWNER OR MANAGER CAN CALL ]
     * @param {string} algodVer - string representing the algorand node daemon version (reti node daemon composes its own meta version)
     */
    updateAlgodVer(algodVer: string): void {
        assert(this.isOwnerOrManagerCaller());
        this.AlgodVer.value = algodVer;
    }

    /**
     * Updates the balance of stakers in the pool based on the received 'rewards' (current balance vs known staked balance)
     * Stakers outstanding balance is adjusted based on their % of stake and time in the current epoch - so that balance
     * compounds over time and staker can remove that amount at will.
     * The validator is paid their percentage each epoch payout.
     *
     * Note: ANYONE can call this.
     */
    epochBalanceUpdate(): void {
        // call the validator contract to get our payout config data
        const validatorConfig = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorConfig>({
            applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
            methodArgs: [this.ValidatorID.value],
        });

        // =====
        // Ensure full Epoch has passed before allowing a new Epoch update to occur
        // =====
        // Since we're being told to payout, we're at epoch 'end' presumably - or close enough
        // but what if we're told to pay really early?  we need to verify that as well.
        const curTime = globals.latestTimestamp;
        // Get configured epoch as seconds since we're block time comparisons will be in seconds
        const epochInSecs = (validatorConfig.PayoutEveryXMins as uint64) * 60;
        if (this.LastPayout.exists) {
            const secsSinceLastPayout = curTime - this.LastPayout.value;
            log(concat('secs since last payout: %i', itob(secsSinceLastPayout)));

            // We've had one payout - so we need to be at least one epoch past the last payout.
            assert(secsSinceLastPayout >= epochInSecs, "Can't payout earlier than last payout + epoch time");
        }
        // Update our payout time - required to match
        this.LastPayout.value = curTime;

        // Determine Token rewards if applicable
        // =====
        // Do we handle token rewards... ?  if so, we need the app address of pool # 1
        const isTokenEligible = validatorConfig.RewardTokenID !== 0;
        let poolOneAppID = this.app.id;
        let poolOneAddress = this.app.address;
        let tokenPayoutRatio: PoolTokenPayoutRatio;

        // Call validator to update our token payout ratio (snapshotting % of whole of all pools so token payout can
        // be divided between pools properly)
        if (isTokenEligible) {
            if (this.PoolID.value !== 1) {
                // If we're not pool 1 - figure out its address..
                poolOneAppID = sendMethodCall<typeof ValidatorRegistry.prototype.getPoolAppID>({
                    applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
                    methodArgs: [this.ValidatorID.value, 1],
                });
                poolOneAddress = AppID.fromUint64(poolOneAppID).address;
            }

            // Snapshot the ratio of token stake per pool across the pools so the token rewards across pools
            // can be based on a stable cross-pool ratio.
            if (this.PoolID.value === 1) {
                tokenPayoutRatio = sendMethodCall<typeof ValidatorRegistry.prototype.setTokenPayoutRatio>({
                    applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
                    methodArgs: [this.ValidatorID.value],
                });
            } else {
                // This isn't pool 2 - so call pool 1 to then ask IT to call the validator to call setTokenPayoutRatio
                tokenPayoutRatio = sendMethodCall<typeof StakingPool.prototype.proxiedSetTokenPayoutRatio>({
                    applicationID: AppID.fromUint64(poolOneAppID),
                    methodArgs: [{ ID: this.ValidatorID.value, PoolID: this.PoolID.value, PoolAppID: this.app.id }],
                });
            }
        }

        // Get the validator state as well - so we know how much token has been held back
        const validatorState = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorState>({
            applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
            methodArgs: [this.ValidatorID.value],
        });
        const rewardTokenHeldBack = validatorState.RewardTokenHeldBack;

        // Determine ALGO rewards if available
        // =====
        // total reward available is current balance - amount staked (so if 100 was staked but balance is 120 - reward is 20)
        // [not counting MBR which should never be counted - it's not payable]
        let algoRewardAvail = this.app.address.balance - this.TotalAlgoStaked.value - this.app.address.minBalance;
        let sendRewardToFeeSink = false;

        // Now verify if our validator has exceeded the maxAllowedStake for the 'protocol' - if so, then we want to
        // send ALL rewards back to the fee sink, and NOT to the validator, or the stakers.  We want people to unstake
        // from the pools to get the total stake for this validator back under the limit.
        if (validatorState.TotalAlgoStaked > this.maxAllowedStake()) {
            log('validator stake exceeded protocol max, all reward sent back to fee sink');
            sendRewardToFeeSink = true;
        }

        // if tokens are rewarded by this validator and determine how much we have to hand out
        // we'll track amount we actually assign out and let our validator know so it can mark that amount
        // as being held back (for tracking what has been assigned for payout)
        let tokenRewardAvail = 0;
        let tokenRewardPaidOut = 0;
        if (isTokenEligible) {
            const tokenRewardBal =
                poolOneAddress.assetBalance(AssetID.fromUint64(validatorConfig.RewardTokenID)) - rewardTokenHeldBack;

            // if they have less tokens available then min payout - just ignore and act like no reward is avail
            // leaving tokenRewardAvail as 0
            if (tokenRewardBal >= validatorConfig.RewardPerPayout) {
                // Now - adjust the token rewards to be relative based on this pools stake as % of 'total validator stake'
                // using our prior snapshotted data
                // @ts-ignore typescript thinks tokenPayoutRatio might not be set prior to this call but it has to be based on isTokenEligible
                const ourPoolPctOfWhole = tokenPayoutRatio.PoolPctOfWhole[this.PoolID.value - 1];

                // now adjust the total reward to hand out for this pool based on this pools % of the whole
                tokenRewardAvail = wideRatio([validatorConfig.RewardPerPayout, ourPoolPctOfWhole], [1_000_000]);
                // increaseOpcodeBudget();
                // log(concat('token ourPctOfWhole: ', (ourPoolPctOfWhole / 10000).toString()));
                // log(concat('token reward held back: ', rewardTokenHeldBack.toString()));
                log(concat('token reward avail: ', tokenRewardAvail.toString()));
                // log(concat('token reward avail: %i', itob(tokenRewardAvail)));
            }
        }
        if (tokenRewardAvail === 0) {
            // no token reward - then algo MUST be paid out !
            // Reward available needs to be at lest 1 algo if an algo reward HAS to be paid out (no token reward)
            assert(algoRewardAvail > 1_000_000, 'Reward needs to be at least 1 ALGO');
        }
        log(concat('algo reward avail: ', algoRewardAvail.toString()));
        // log(concat('algo reward avail: %i', itob(algoRewardAvail)));

        if (sendRewardToFeeSink) {
            sendPayment({
                amount: algoRewardAvail,
                receiver: this.getFeeSink(),
                note: 'validator exceeded protocol max, rewards sent back to fee sink',
            });
            algoRewardAvail = 0;
        } else if (validatorConfig.PercentToValidator !== 0) {
            // determine the % that goes to validator...
            // ie: 100[algo] * 50_000 (5% w/4 decimals) / 1_000_000 == 5 [algo]
            const validatorPay = wideRatio(
                [algoRewardAvail, validatorConfig.PercentToValidator as uint64],
                [1_000_000]
            );

            // and adjust reward for entire pool accordingly
            algoRewardAvail -= validatorPay;

            // ---
            // pay the validator their cut...
            if (validatorPay > 0) {
                log(concat('paying validator: %i', itob(validatorPay)));
                sendPayment({
                    amount: validatorPay,
                    receiver: validatorConfig.ValidatorCommissionAddress,
                    note: 'validator reward',
                });
                log(concat('remaining reward: %i', itob(algoRewardAvail)));
            }
        }

        if (algoRewardAvail === 0 && tokenRewardAvail === 0) {
            // likely a personal validator node - probably had validator % at 1000 and we just issued the entire reward
            // to them.  Since we also have no token reward to assign - we're done
            return;
        }

        // Now we "pay" (but really just update their tracked balance) the stakers the remainder based on their % of
        // pool and time in this epoch.

        // We'll track the amount of stake we add to stakers based on payouts
        // If any dust is remaining in account it'll be considered part of reward in next epoch.
        let increasedStake = 0;

        /**
         * assume A)lice and B)ob have equal stake... and there is a reward of 100 to divide
         * |------|-------|...
         * A  B
         *        ^ B gets 50% (or 25 of the 50)
         *        at end - we now have 75 'left' - which gets divided across the people at >=100% of epoch time
         *         *        intended result for 100 reward:
         *        if A and B have equal stake... they're each 50% of the 'pool' - call that PP (pool percent)
         *        Time in the epoch - TIE (100% would mean entire epoch - 50% TIE means entered halfway in)
         *        So, we first pay all partials (<100 TIE)
         *        B gets 25....  (100 REWARD * 50 PP (.5) * 50 TIE (.5)) or 25.
         *        -- keep total of stake from each of partial - adding into PartialStake value.
         *        --  we then see that 25 got paid out - so 25 'excess' needs distributed to the 100 TIE stakers on top of their reward.
         *        - reward available is now 75 ALGO to distribute - and PP value is based on percent against new total (TotalStaked-PartialStake)
         *        - so A's PP is now 100% not 50% because their stake is equal to the new reduced stake amount
         *        so A gets 75 (75 REWARD * 100 PP (1) * 100 TIE (1)) or 75
         *        next epoch if nothing else changes - each would get 50% of reward.
         */
        // Iterate all stakers - determine which haven't been for entire epoch - pay them proportionally less for having
        // less time in pool.  We keep track of their stake and then will later reduce the effective 'total staked' amount
        // by that so that the remaining stakers get the remaining reward + excess based on their % of stake against
        // remaining participants.
        let partialStakersTotalStake: uint64 = 0;
        for (let i = 0; i < this.Stakers.value.length; i += 1) {
            if (globals.opcodeBudget < 400) {
                increaseOpcodeBudget();
            }
            const cmpStaker = clone(this.Stakers.value[i]);
            if (cmpStaker.Account !== globals.zeroAddress) {
                if (cmpStaker.EntryTime > curTime) {
                    // due to 'forward dating' entry time this could be possible
                    // in this case it definitely means they get 0%
                    partialStakersTotalStake += cmpStaker.Balance;
                } else {
                    // Reward is % of users stake in pool,
                    // but we deduct based on time away from our payout time
                    const timeInPool = curTime - cmpStaker.EntryTime;
                    let timePercentage: uint64;
                    // get % of time in pool (in tenths precision)
                    // ie: 34.7% becomes 347
                    if (timeInPool < epochInSecs) {
                        partialStakersTotalStake += cmpStaker.Balance;
                        timePercentage = (timeInPool * 1000) / epochInSecs;

                        // log(concat('% in pool: ', (timePercentage / 10).toString()));
                        if (tokenRewardAvail > 0) {
                            // calc: (balance * avail reward * percent in tenths) / (total staked * 1000)
                            const stakerTokenReward = wideRatio(
                                [cmpStaker.Balance, tokenRewardAvail, timePercentage],
                                [this.TotalAlgoStaked.value, 1000]
                            );

                            // reduce the reward available (that we're accounting for) so that the subsequent
                            // 'full' pays are based on what's left
                            tokenRewardAvail -= stakerTokenReward;
                            cmpStaker.RewardTokenBalance += stakerTokenReward;
                            tokenRewardPaidOut += stakerTokenReward;
                        }
                        if (algoRewardAvail > 0) {
                            // calc: (balance * avail reward * percent in tenths) / (total staked * 1000)
                            const stakerReward = wideRatio(
                                [cmpStaker.Balance, algoRewardAvail, timePercentage],
                                [this.TotalAlgoStaked.value, 1000]
                            );

                            // reduce the reward available (that we're accounting for) so that the subsequent
                            // 'full' pays are based on what's left
                            algoRewardAvail -= stakerReward;
                            // instead of sending them algo now - just increase their ledger balance, so they can claim
                            // it at any time.
                            cmpStaker.Balance += stakerReward;
                            cmpStaker.TotalRewarded += stakerReward;
                            increasedStake += stakerReward;
                        }
                        // Update the box w/ the new data
                        this.Stakers.value[i] = cmpStaker;
                    }
                }
            }
        }
        log(concat('partial staker total stake: %i', itob(partialStakersTotalStake)));

        // Reduce the virtual 'total staked in pool' amount based on removing the totals of the stakers we just paid
        // partial amounts.  This is so that all that remains is the stake of the 100% 'time in epoch' people.
        const newPoolTotalStake = this.TotalAlgoStaked.value - partialStakersTotalStake;

        // It's technically possible for newPoolTotalStake to be 0, if EVERY staker is new then there'll be nothing to
        // hand out this epoch because we'll have reduced the amount to 'count' towards stake by the entire stake
        if (newPoolTotalStake > 0) {
            // Now go back through the list AGAIN and pay out the full-timers their rewards + excess
            for (let i = 0; i < this.Stakers.value.length; i += 1) {
                if (globals.opcodeBudget < 200) {
                    increaseOpcodeBudget();
                }
                const cmpStaker = clone(this.Stakers.value[i]);
                if (cmpStaker.Account !== globals.zeroAddress && cmpStaker.EntryTime < curTime) {
                    const timeInPool = curTime - cmpStaker.EntryTime;
                    // We're now only paying out people who've been in pool an entire epoch.
                    if (timeInPool >= epochInSecs) {
                        // we're in for 100%, so it's just % of stakers balance vs 'new total' for their
                        // payment

                        // Handle token payouts first - as we don't want to use existin balance, not post algo-reward balance
                        if (tokenRewardAvail > 0) {
                            // increaseOpcodeBudget();
                            // log(concat('staker balance: ', cmpStaker.Balance.toString()));
                            // log(concat('tkn rwd avail: ', tokenRewardAvail.toString()));
                            // increaseOpcodeBudget();
                            // log(concat('new pool stake: ', newPoolTotalStake.toString()));

                            const stakerTokenReward = wideRatio(
                                [cmpStaker.Balance, tokenRewardAvail],
                                [newPoolTotalStake]
                            );
                            // increaseOpcodeBudget();
                            // log(concat('paying staker token reward: ', stakerTokenReward.toString()));

                            // instead of sending them algo now - just increase their ledger balance, so they can claim
                            // it at any time.
                            cmpStaker.RewardTokenBalance += stakerTokenReward;
                            tokenRewardPaidOut += stakerTokenReward;
                        }
                        if (algoRewardAvail > 0) {
                            const stakerReward = wideRatio([cmpStaker.Balance, algoRewardAvail], [newPoolTotalStake]);
                            // instead of sending them algo now - just increase their ledger balance, so they can claim
                            // it at any time.
                            cmpStaker.Balance += stakerReward;
                            cmpStaker.TotalRewarded += stakerReward;
                            increasedStake += stakerReward;
                        }

                        // Update the box w/ the new data
                        this.Stakers.value[i] = cmpStaker;
                    }
                }
            }
        }
        // We've paid out the validator and updated the stakers new balances to reflect the rewards, now update
        // our 'total staked' value as well based on what we paid to validator and updated in staker balances as we
        // determined stake increases
        this.TotalAlgoStaked.value += increasedStake;

        log(concat('increased stake: %i', itob(increasedStake)));
        log(concat('token reward paid out: %i', itob(tokenRewardPaidOut)));

        // Call the validator contract and tell it we've got new stake added
        // It'll verify we're a valid staking pool id and update it
        // stakeUpdatedViaRewards((uint64,uint64,uint64),uint64)void
        sendMethodCall<typeof ValidatorRegistry.prototype.stakeUpdatedViaRewards>({
            applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
            methodArgs: [
                { ID: this.ValidatorID.value, PoolID: this.PoolID.value, PoolAppID: this.app.id },
                increasedStake,
                tokenRewardPaidOut,
            ],
        });
    }

    /**
     * Registers a staking pool key online against a participation key.
     * [ ONLY OWNER OR MANAGER CAN CALL ]
     *
     * @param {bytes} votePK - The vote public key.
     * @param {bytes} selectionPK - The selection public key.
     * @param {bytes} stateProofPK - The state proof public key.
     * @param {uint64} voteFirst - The first vote index.
     * @param {uint64} voteLast - The last vote index.
     * @param {uint64} voteKeyDilution - The vote key dilution value.
     * @throws {Error} Will throw an error if the caller is not the owner or a manager.
     */
    goOnline(
        votePK: bytes,
        selectionPK: bytes,
        stateProofPK: bytes,
        voteFirst: uint64,
        voteLast: uint64,
        voteKeyDilution: uint64
    ): void {
        assert(this.isOwnerOrManagerCaller());
        sendOnlineKeyRegistration({
            votePK: votePK,
            selectionPK: selectionPK,
            stateProofPK: stateProofPK,
            voteFirst: voteFirst,
            voteLast: voteLast,
            voteKeyDilution: voteKeyDilution,
        });
    }

    /**
     * Marks a staking pool key OFFLINE.
     * [ ONLY OWNER OR MANAGER CAN CALL ]
     *
     */
    goOffline(): void {
        // we can be called by validator contract if we're being moved (which in turn only is allowed to be called
        // by validator owner or manager), but if not - must be owner or manager
        if (this.txn.sender !== AppID.fromUint64(this.CreatingValidatorContractAppID.value).address) {
            assert(this.isOwnerOrManagerCaller());
        }

        sendOfflineKeyRegistration({});
    }

    // Links the staking pool's account address to an NFD
    // the contract account address must already be set into the NFD's u.cav.algo.a field pending verification
    // [ ONLY OWNER OR MANAGER CAN CALL ]
    linkToNFD(nfdAppID: uint64, nfdName: string): void {
        assert(this.isOwnerOrManagerCaller());

        sendAppCall({
            applicationID: AppID.fromUint64(this.NFDRegistryAppID),
            applicationArgs: ['verify_nfd_addr', nfdName, itob(nfdAppID), rawBytes(this.app.address)],
        });
    }

    /**
     * proxiedSetTokenPayoutRatio is meant to be called by pools != 1 - calling US, pool #1
     * We need to verify that we are in fact being called by another of OUR pools (not us)
     * and then we'll call the validator on their behalf to update the token payouts
     * @param poolKey - ValidatorPoolKey tuple
     */
    proxiedSetTokenPayoutRatio(poolKey: ValidatorPoolKey): PoolTokenPayoutRatio {
        assert(this.ValidatorID.value === poolKey.ID, 'caller must be part of same validator set!');
        assert(this.PoolID.value === 1, 'callee must be pool 1');
        assert(poolKey.PoolID !== 1, 'caller must NOT be pool 1');

        const callerPoolAppID = sendMethodCall<typeof ValidatorRegistry.prototype.getPoolAppID>({
            applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
            methodArgs: [poolKey.ID, poolKey.PoolID],
        });
        assert(callerPoolAppID === poolKey.PoolAppID);
        assert(this.txn.sender === AppID.fromUint64(poolKey.PoolAppID).address);

        return sendMethodCall<typeof ValidatorRegistry.prototype.setTokenPayoutRatio>({
            applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
            methodArgs: [this.ValidatorID.value],
        });
    }

    private isOwnerOrManagerCaller(): boolean {
        const OwnerAndManager = sendMethodCall<typeof ValidatorRegistry.prototype.getValidatorOwnerAndManager>({
            applicationID: AppID.fromUint64(this.CreatingValidatorContractAppID.value),
            methodArgs: [this.ValidatorID.value],
        });
        return this.txn.sender === OwnerAndManager[0] || this.txn.sender === OwnerAndManager[1];
    }

    /**
     * Calculate the entry time for counting a stake as entering the pool.
     * Algorand won't see the balance increase for ALGORAND_STAKING_BLOCK_DELAY rounds, so we approximate it.
     * The entry time is calculated by adding an approximate number of seconds based on current AVG block times
     * to the original entry time.  This means users don't get payouts based on time their balance wouldn't have
     * been seen by the network.
     *
     * @returns {uint64} - The updated entry time.
     */
    private getEntryTime(): uint64 {
        // entry time is the time we want to count this stake as entering the pool.  Algorand won't see the balance
        // increase for 320 rounds so approximate it as best we can
        const entryTime = globals.latestTimestamp;
        // we add 320 blocks * AVG_BLOCK_TIME_SECS (which is in tenths, where 30 represents 3 seconds)
        // adding that approximate number of seconds to the entry time.
        return entryTime + (ALGORAND_STAKING_BLOCK_DELAY * AVG_BLOCK_TIME_SECS) / 10;
    }

    private getFeeSink(): Address {
        return this.FeeSinkAddr;
        // will be like: txn FirstValid; int 1; -; block BlkFeeSink
        // once available in AVM
    }

    /**
     * Returns the maximum allowed stake per validator based on a percentage of all current online stake
     */
    private maxAllowedStake(): uint64 {
        const online = this.getCurrentOnlineStake();

        return wideRatio([online, MAX_VALIDATOR_PCT_OF_ONLINE], [1000]);
    }

    private getCurrentOnlineStake(): uint64 {
        // TODO - replace w/ appropriate AVM call once available but return fixed 2 billion for now.
        return 2_000_000_000_000_000;
    }
}
