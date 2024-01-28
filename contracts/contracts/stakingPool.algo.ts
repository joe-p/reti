import { Contract } from '@algorandfoundation/tealscript';
// import { ValidatorConfig } from "./validatorRegistry.algo";
import { MAX_ALGO_PER_POOL } from './constants.algo';

const MAX_STAKERS_PER_POOL = 80;

type StakedInfo = {
    Account: Address;
    Balance: uint64;
    EntryTime: uint64;
};

// eslint-disable-next-line no-unused-vars
class StakingPool extends Contract {
    programVersion = 9;

    CreatingValidatorContractAppID = GlobalStateKey<uint64>({key:'creatorApp'});

    ValidatorID = GlobalStateKey<uint64>({key: 'validatorID'});

    PoolID = GlobalStateKey<uint64>({key: 'poolID'});

    Owner = GlobalStateKey<Address>({key: 'owner'});

    Manager = GlobalStateKey<Address>({key: 'manager'});

    NumStakers = GlobalStateKey<uint64>({key: 'numStakers'});

    TotalAlgoStaked = GlobalStateKey<uint64>({key: 'staked'});

    MaxAlgo = GlobalStateKey<uint64>({key: 'maxStake'});

    Stakers = BoxKey<StaticArray<StakedInfo, typeof MAX_STAKERS_PER_POOL>>({key: 'stakers'});

    /**
     * Initialize the staking pool w/ owner and manager, but can only be created by the validator contract.
     * @param creatingContractID - id of contract that constructed us - the validator application (single global instance)
     * @param validatorID - id of validator we're a staking pool of
     * @param poolID - which pool id are we
     * @param owner
     * @param manager
     */
    createApplication(creatingContractID:uint64,  validatorID: uint64, poolID: uint64, owner: Address, manager: Address): void {
        this.CreatingValidatorContractAppID.value = creatingContractID;
        this.ValidatorID.value = validatorID; // Which valida
        this.PoolID.value = poolID;
        this.Owner.value = owner;
        this.Manager.value = manager;
        this.NumStakers.value = 0;
        this.TotalAlgoStaked.value = 0;
        this.MaxAlgo.value = MAX_ALGO_PER_POOL;
        this.Stakers.create();
    }

    /**
     * Adds stake to the given account.
     * Can ONLY be called by the validator contract that created us
     * Must receive payment from the validator contract for amount being staked.
     *
     * @param {Address} account - The account adding new stake
     * @param {uint64} amountToStake - The amount to stake.
     * @throws {Error} - Throws an error if the staking pool is full.
     * @returns {uint64,} new 'entry time' in seconds of stake add.
     */
    addStake(account: Address, amountToStake: uint64): uint64 {
        // account calling us has to be our creating validator contract
        assert(account !== Account.zeroAddress);
        assert(this.txn.sender === Application.fromID(this.CreatingValidatorContractAppID.value).address);

        // Now, is the required amount actually being paid to US (this contract account - the staking pool)
        // Sender doesn't matter - but it 'technically' should be coming from the Validator contract address
        verifyPayTxn(this.txnGroup[this.txn.groupIndex - 1], {
            sender: Application.fromID(this.CreatingValidatorContractAppID.value).address,
            receiver: this.app.address,
            amount: amountToStake,
        });
        // See if the account staking is already in our ledger of Stakers - if so, they're just adding to their stake
        // track first empty slot as we go along as well.
        const entryTime = globals.latestTimestamp;
        let firstEmpty = 0;

        // firstEmpty should represent 1-based index to first empty slot we find - 0 means none were found
        let i = 0;
        this.Stakers.value.forEach(staker => {
            if (staker.Account === account) {
                staker.Balance += amountToStake;
                staker.EntryTime = entryTime;
                this.TotalAlgoStaked.value += amountToStake;
                return entryTime;
            }
            if (firstEmpty != 0 && staker.Account === Address.zeroAddress) {
                firstEmpty = i + 1;
            }
            i += 1;
        });

        if (firstEmpty == 0) {
            // nothing was found - pool is full and this staker can't fit
            throw Error('Staking pool full');
        }
        assert(this.Stakers.value[firstEmpty - 1].Account == Address.zeroAddress);
        this.Stakers.value[firstEmpty - 1] = {
            Account: account,
            Balance: amountToStake,
            EntryTime: entryTime,
        };
        this.NumStakers.value += 1;
        this.TotalAlgoStaked.value += amountToStake;
        return entryTime;
    }

    /**
     * Removes stake on behalf of a particular staker.  Also notifies the validator contract for this pools
     * validaotr of the staker / balance changes.
     *
     * @param {Address} account - The address of the account removing stake.
     * @param {uint64} amountToUnstake - The amount of stake to be removed.
     * @throws {Error} If the account has insufficient balance or if the account is not found.
     */
    removeStake(account: Address, amountToUnstake: uint64): void {
        // We want to preserve the sanctity that the ONLY account that can call us is the staking account
        // It makes it a bit awkward this way to update the state in the validator but it's safer

        // account calling us has to be account removing stake
        assert(account !== Account.zeroAddress);
        assert(this.txn.sender === account);

        this.Stakers.value.forEach(staker => {
            if (staker.Account === account) {
                if (staker.Balance < amountToUnstake) {
                    throw Error('Insufficient balance');
                }
                staker.Balance -= amountToUnstake;
                this.TotalAlgoStaked.value -= amountToUnstake;

                // Pay the staker back
                sendPayment({
                    amount: amountToUnstake,
                    receiver: account,
                    note: 'unstaked',
                });
                let stakerRemoved = false;
                if (staker.Balance === 0) {
                    // Staker has been 'removed'
                    this.NumStakers.value -= 1;
                    staker.Account = Address.zeroAddress;
                    stakerRemoved = true;
                }
                // Call the validator contract and tell it we're removing stake
                // It'll verify we're a valid staking pool id ?
                sendMethodCall<[uint64, uint64, Address, uint64, boolean], void>({
                    applicationID: Application.fromID(this.CreatingValidatorContractAppID.value),
                    name: 'stakeRemoved',
                    methodArgs: [this.ValidatorID.value, this.PoolID.value, account, amountToUnstake, stakerRemoved],
                });
                // Now we need to tell the validator contract to remove
                return;
            }
        });
        throw Error('Account not found');
    }

    payStakers(): void {
        // we should only be callable by owner or manager of validator.
        assert(this.txn.sender == this.Owner.value || this.txn.sender === this.Manager.value);

        // call the validator contract to get our payout data
        const payoutConfig = sendMethodCall<[uint64], [uint16, uint32, Address, uint8, uint16]>({
            applicationID: Application.fromID(this.CreatingValidatorContractAppID.value),
            name: 'getValidatorConfig',
            methodArgs: [this.ValidatorID.value],
        });
        // first two members of the return value is:
        //  PayoutEveryXDays - Payout frequency - ie: 7, 30, etc.
        //  PercentToValidator- Payout percentage expressed w/ four decimals - ie: 50000 = 5% -> .0005
        const payoutDays = payoutConfig[0] as uint64;
        const pctToValidator = payoutConfig[1] as uint64;
        const validatorCommissionAddress = payoutConfig[2];

        // total reward available is current balance - amount staked (so if 100 was staked but balance is 120 - reward is 20)
        // [not counting MBR which would be included in base balance anyway but - have to be safe...]
        let rewardAvailable = this.app.address.balance - this.TotalAlgoStaked.value - this.app.address.minBalance;
        // determine the % that goes to validator...
        const validatorPay = wideRatio([rewardAvailable, pctToValidator], [1000000]);
        // and adjust reward for entire pool accordingly
        rewardAvailable -= validatorPay;

        // ---
        // pay the validator first their cut
        sendPayment({
            amount: validatorPay,
            receiver: validatorCommissionAddress,
            note: 'validator reward',
        });

        // -- now we pay the stakers the remainder based on their % of pool and time in this epoch.

        // Since we're being told to payout - treat this as epoch end
        // We're at epoch 'end' presumably - or close enough
        // but what if we're told to pay really early?  it should just mean
        // the reward is smaller.  It shouldn't be an issue.
        const curTime = globals.latestTimestamp;
        // How many seconds in an epoch..
        const payoutDaysInSecs = payoutDays * 24 * 60 * 60;

        this.Stakers.value.forEach((staker) => {
            if (staker.Account !== Address.zeroAddress) {
                // Reward is % of users stake in pool
                // but we deduct based on time in pool
                const timeInPool = curTime - staker.EntryTime;
                let timePercentage: uint64;
                // get % of time in pool
                if (timeInPool >= payoutDaysInSecs) {
                    timePercentage = 1000; // == 1.000%
                } else {
                    timePercentage = (timeInPool * 1000) / payoutDaysInSecs;
                }
                // ie: 200(000000) algo staked out of 1000(000000) algo
                // and reward is 15(000000) algo
                // (200000000 * 15000000 * 1000) / 1000000000 / 1000
                // or - 3 algo (20% of 15 algo)
                const stakerReward = wideRatio(
                    [staker.Balance, rewardAvailable, timePercentage],
                    [this.TotalAlgoStaked.value, 1000]
                );
                sendPayment({
                    amount: stakerReward,
                    receiver: staker.Account,
                    note: 'staker reward',
                });
            }
        });
    }

    GoOnline(
        votePK: bytes,
        selectionPK: bytes,
        stateProofPK: bytes,
        voteFirst: uint64,
        voteLast: uint64,
        voteKeyDilution: uint64
    ): void {
        assert(this.txn.sender == this.Owner.value || this.txn.sender === this.Manager.value);
        sendOnlineKeyRegistration({
            votePK: votePK,
            selectionPK: selectionPK,
            stateProofPK: stateProofPK,
            voteFirst: voteFirst,
            voteLast: voteLast,
            voteKeyDilution: voteKeyDilution,
        });
    }

    GoOffline(): void {
        assert(this.txn.sender == this.Owner.value || this.txn.sender === this.Manager.value);
        sendOfflineKeyRegistration({});
    }
}
