import { Contract } from '@algorandfoundation/tealscript';
import { MAX_ALGO_PER_POOL, MIN_ALGO_STAKE_PER_POOL } from './constants.algo';

const MAX_NODES = 12; // need to be careful of max size of ValidatorList and embedded PoolInfo
const MAX_POOLS_PER_NODE = 4; // max number of pools per node - more than 4 gets dicey - preference is 3(!)
const MAX_POOLS = MAX_NODES * MAX_POOLS_PER_NODE;
const MIN_PAYOUT_DAYS = 1;
const MAX_PAYOUT_DAYS = 30;
const MIN_PCT_TO_VALIDATOR = 10000; // 1% w/ four decimals - (this allows .0001%)
const MAX_PCT_TO_VALIDATOR = 100000; // 10% w/ four decimals

type ValidatorID = uint64;
type ValidatorPoolKey = {
    ID: ValidatorID;
    PoolID: uint64; // 0 means INVALID ! - so 1 is index, technically of [0]
    PoolAppID: uint64;
};

export type ValidatorConfig = {
    PayoutEveryXDays: uint16; // Payout frequency - ie: 7, 30, etc.
    PercentToValidator: uint32; // Payout percentage expressed w/ four decimals - ie: 50000 = 5% -> .0005 -
    ValidatorCommissionAddress: Address; // account that receives the validation commission each epoch payout
    MinAllowedStake: uint64; // minimum stake required to enter pool - but must withdraw all if want to go below this amount as well(!)
    MaxAlgoPerPool: uint64; // maximum stake allowed per pool (to keep under incentive limits)
    PoolsPerNode: uint8; // Number of pools to allow per node (max of 4 is recommended)
    MaxNodes: uint16; // Maximum number of nodes the validator is stating they'll allow
};

type ValidatorCurState = {
    NumPools: uint16; // current number of pools this validator has - capped at MaxPools
    TotalStakers: uint64; // total number of stakers across all pools
    TotalAlgoStaked: uint64; // total amount staked to this validator across ALL of its pools
};

type PoolInfo = {
    NodeID: uint16;
    PoolAppID: uint64; // The App ID of this staking pool contract instance
    TotalStakers: uint16;
    TotalAlgoStaked: uint64;
};

type NodeInfo = {
    ID: uint16; // just sequentially assigned... can only be a few anyway..
    Name: StaticArray<byte, 32>;
};

type ValidatorInfo = {
    ID: ValidatorID; // ID of this validator (sequentially assigned)
    Owner: Address; // Account that controls config - presumably cold-wallet
    Manager: Address; // Account that triggers/pays for payouts and keyreg transactions - needs to be hotwallet as node has to sign for the transactions
    NFDForInfo: uint64; // Optional NFD AppID which the validator uses to describe their validator pool
    Config: ValidatorConfig;
    State: ValidatorCurState;
    Nodes: StaticArray<NodeInfo, typeof MAX_NODES>;
    Pools: StaticArray<PoolInfo, typeof MAX_POOLS>;
};

type MbrAmounts = {
    AddValidatorMbr: uint64;
    AddPoolMbr: uint64;
    AddStakerMbr: uint64;
};

const ALGORAND_ACCOUNT_MIN_BALANCE = 100000;

// values taken from: https://developer.algorand.org/docs/features/asc1/stateful/#minimum-balance-requirement-for-a-smart-contract
const APPLICATION_BASE_FEE = 100000; // base fee for creating or opt-in to application
const ASSET_HOLDING_FEE = 100000; // creation fee for asset
const SSC_VALUE_UINT = 28500; // cost for value as uint64
const SSC_VALUE_BYTES = 50000; // cost for value as bytes

const SCBOX_PERBOX = 2500;
const SCBOX_PERBYTE = 400;

// eslint-disable-next-line no-unused-vars
class ValidatorRegistry extends Contract {
    programVersion = 9;

    // globalState = GlobalStateMap<bytes, bytes>({ maxKeys: 3 });
    numValidators = GlobalStateKey<uint64>({ key: 'numV' });

    // Validator list - simply incremental id - direct access to info for validator
    // and also contains all pool information (but not user-account ledger per pool)
    ValidatorList = BoxMap<ValidatorID, ValidatorInfo>({ prefix: 'v' });

    // For given user staker address, which of up to 4 validator/pools are they in
    StakerPoolSet = BoxMap<Address, StaticArray<ValidatorPoolKey, 4>>({ prefix: 'sps' });

    // The app id of a staking pool contract instance to use as template for newly created pools
    StakingPoolTemplateAppID = GlobalStateKey<uint64>({ key: 'poolTemplateAppID' });

    createApplication(poolTemplateAppID: uint64): void {
        this.numValidators.value = 0;
        this.StakingPoolTemplateAppID.value = poolTemplateAppID;
    }

    /**
     * gas is a dummy no-op call that can be used to pool-up resource references and opcode cost
     */
    gas(): void {}

    private minBalanceForAccount(
        contracts: number,
        extraPages: number,
        assets: number,
        localInts: number,
        localBytes: number,
        globalInts: number,
        globalBytes: number
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

    private costForBoxStorage(totalNumBytes: number): uint64 {
        return SCBOX_PERBOX + totalNumBytes * SCBOX_PERBYTE;
    }

    // Cost for creator of validator contract itself is:
    // this.minBalanceForAccount(0, 0, 0, 0, 0, 2, 0)

    getMbrAmounts(): MbrAmounts {
        return {
            AddValidatorMbr:
                this.costForBoxStorage(1 /* v prefix */ + 8 /* key id size */ + 1523 /* ValidatorInfo struct size */),
            AddPoolMbr: this.minBalanceForAccount(1, 0, 0, 0, 0, 7, 2),
            AddStakerMbr:
                // how much to charge for first time a staker adds stake - since we add a tracking box per staker
                this.costForBoxStorage(3 /* 'sps' prefix */ + 32 /* account */ + 24 /* ValidatorPoolKey size */ * 4), // size of key + all values
        };
    }

    /**
     * Returns the current number of validators
     */
    // @abi.readonly
    getNumValidators(): uint64 {
        return this.numValidators.value;
    }

    // @abi.readonly
    getValidatorInfo(validatorID: ValidatorID): ValidatorInfo {
        return this.ValidatorList(validatorID).value;
    }

    // @abi.readonly
    getValidatorConfig(validatorID: ValidatorID): ValidatorConfig {
        return this.ValidatorList(validatorID).value.Config;
    }

    // @abi.readonly
    getValidatorState(validatorID: ValidatorID): ValidatorCurState {
        return this.ValidatorList(validatorID).value.State;
    }

    // @abi.readonly
    getPoolInfo(poolKey: ValidatorPoolKey): PoolInfo {
        return this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1];
    }

    /** Adds a new validator
     * @param owner The account (presumably cold-wallet) that owns the validator set
     * @param manager The account that manages the pool part. keys and triggers payouts.  Normally a hot-wallet as node sidecar needs the keys
     * @param nfdAppID Optional NFD App ID linking to information about the validator being added - where information about the validator and their pools can be found.
     * @param config ValidatorConfig struct
     */
    addValidator(owner: Address, manager: Address, nfdAppID: uint64, config: ValidatorConfig): uint64 {
        assert(owner !== Address.zeroAddress);
        assert(manager !== Address.zeroAddress);

        this.validateConfig(config);

        // We're adding a new validator - same owner might have multiple - we don't care.
        const validatorID = this.numValidators.value + 1;
        this.numValidators.value = validatorID;

        this.ValidatorList(validatorID).create();
        this.ValidatorList(validatorID).value.ID = validatorID;
        this.ValidatorList(validatorID).value.Owner = owner;
        this.ValidatorList(validatorID).value.Manager = manager;
        this.ValidatorList(validatorID).value.NFDForInfo = nfdAppID;
        this.ValidatorList(validatorID).value.Config = config;
        // TODO - what about nodes ?
        this.ValidatorList(validatorID).value.Nodes[0].Name = 'foo';
        return validatorID;
    }

    /** Adds a new pool to a validator's pool set, returning the 'key' to reference the pool in the future for staking, etc.
     * The caller must pay the cost of the validators MBR increase as well as the MBR that will be needed for the pool itself.
     * @param {PayTxn} mbrPayment payment from caller which covers mbr increase of valiator pool + staking pool
     * @param {uint64} validatorID is ID of validator to pool to (must be owner or manager)
     * @returns {ValidatorPoolKey} pool key to created pool
     *
     */
    addPool(mbrPayment: PayTxn, validatorID: ValidatorID): ValidatorPoolKey {
        verifyPayTxn(mbrPayment, { amount: this.getMbrAmounts().AddPoolMbr });

        assert(this.ValidatorList(validatorID).exists);

        // Must be called by the owner or manager of the validator.
        assert(
            this.txn.sender === this.ValidatorList(validatorID).value.Owner ||
                this.txn.sender === this.ValidatorList(validatorID).value.Manager
        );

        let numPools = this.ValidatorList(validatorID).value.State.NumPools;
        if ((numPools as uint64) >= MAX_POOLS) {
            throw Error('already at max pool size');
        }
        numPools += 1;

        // Create the actual staker pool contract instance
        sendAppCall({
            onCompletion: OnCompletion.NoOp,
            approvalProgram: Application.fromID(this.StakingPoolTemplateAppID.value).approvalProgram,
            clearStateProgram: Application.fromID(this.StakingPoolTemplateAppID.value).clearStateProgram,
            globalNumUint: Application.fromID(this.StakingPoolTemplateAppID.value).globalNumUint,
            globalNumByteSlice: Application.fromID(this.StakingPoolTemplateAppID.value).globalNumByteSlice,
            extraProgramPages: Application.fromID(this.StakingPoolTemplateAppID.value).extraProgramPages,
            applicationArgs: [
                // creatingContractID, validatorID, poolID, owner, manager, minAllowedStake, maxStakeAllowed
                method('createApplication(uint64,uint64,uint64,address,address,uint64,uint64)void'),
                itob(this.app.id),
                itob(validatorID),
                itob(numPools as uint64),
                rawBytes(this.ValidatorList(validatorID).value.Owner),
                rawBytes(this.ValidatorList(validatorID).value.Manager),
                itob(this.ValidatorList(validatorID).value.Config.MinAllowedStake),
                itob(this.ValidatorList(validatorID).value.Config.MaxAlgoPerPool),
            ],
        });

        this.ValidatorList(validatorID).value.State.NumPools = numPools;
        // We don't need to manipulate anything in the Pools array as the '0' values are all correct for PoolInfo
        // No stakers, no algo staked
        this.ValidatorList(validatorID).value.Pools[numPools - 1].PoolAppID = this.itxn.createdApplicationID.id;

        // PoolID is 1-based, 0 is invalid id
        return { ID: validatorID, PoolID: numPools as uint64, PoolAppID: this.itxn!.createdApplicationID.id };
    }

    getPoolAppID(poolKey: ValidatorPoolKey): uint64 {
        return this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].PoolAppID;
    }

    /**
     * Adds stake to a validator pool.
     *
     * @param {PayTxn} stakedAmountPayment - payment coming from staker to place into a pool
     * @param {ValidatorID} validatorID - The ID of the validator.
     * @returns {ValidatorPoolKey} - The key of the validator pool.
     */
    addStake(stakedAmountPayment: PayTxn, validatorID: ValidatorID): ValidatorPoolKey {
        const staker = this.txn.sender;
        // The prior transaction should be a payment to this pool for the amount specified
        // plus enough in fees to cover our itxn fee to send to the staking pool (not our problem to figure out)
        verifyPayTxn(stakedAmountPayment, {
            sender: staker,
            receiver: this.app.address,
        });

        // find existing slot where staker is already in a pool, or if none found, then ensure they're
        // putting in minimum amount for this validator.
        const poolKey = this.findPoolForStaker(validatorID, staker, stakedAmountPayment.amount);
        if (poolKey.PoolID === 0) {
            throw Error('No pool available with free stake.  Validator needs to add another pool');
        }
        let mbrAmtLeftBehind: uint64 = 0;
        // determine if this is FIRST time this user has staked with this pool
        if (!this.StakerPoolSet(staker).exists) {
            // We'll deduct the required MBR from what the user is depositing by telling callPoolAddState to leave
            // that amount behind and subtract from their depositing stake.
            mbrAmtLeftBehind = this.getMbrAmounts().AddStakerMbr;
            this.StakerPoolSet(staker).create();
        }

        // Update StakerPoolList for this found pool (new or existing)
        this.updateStakerPoolSet(staker, poolKey);
        increaseOpcodeBudget();
        // Send the callers algo amount (- mbrAmtLeftBehind) to the specified staking pool and it then updates
        // the staker data.
        this.callPoolAddStake(stakedAmountPayment, poolKey, mbrAmtLeftBehind);
        return poolKey;
    }

    /**
     * stakeUpdatedViaRewards is called by Staking Pools to inform the validator (us) that a particular amount of total stake has been removed
     * from the specified pool.  This is used to update the stats we have in our PoolInfo storage.
     * The calling App ID is validated against our pool list as well.
     * @param poolKey - ValidatorPoolKey type - [validatorID, PoolID] compound type
     * @param amountToAdd
     */
    stakeUpdatedViaRewards(poolKey: ValidatorPoolKey, amountToAdd: uint64): void {
        assert(this.ValidatorList(poolKey.ID).exists);
        assert((poolKey.PoolID as uint64) < 2 ** 16); // since we limit max pools but keep the interface broad
        assert(poolKey.PoolID > 0 && (poolKey.PoolID as uint16) <= this.ValidatorList(poolKey.ID).value.State.NumPools);
        // validator id, pool id, pool app id might still be kind of spoofed but they can't spoof us verifying they called us from
        // the contract address of the pool app id they represent.
        assert(
            poolKey.PoolAppID === this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].PoolAppID,
            "The passed in app id doesn't match the passed in ids"
        );
        // Sender has to match the pool app id passed in as well.
        assert(this.txn.sender === Application.fromID(poolKey.PoolAppID).address);
        // verify its state matches as well
        assert(poolKey.ID === (Application.fromID(poolKey.PoolAppID).globalState('validatorID') as uint64));
        assert(poolKey.PoolID === (Application.fromID(poolKey.PoolAppID).globalState('poolID') as uint64));

        // Remove the specified amount of stake - update pool stats, then total validator stats
        this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].TotalAlgoStaked += amountToAdd;
        this.ValidatorList(poolKey.ID).value.State.TotalAlgoStaked += amountToAdd;
    }

    /**
     * stakerRemoved is called by Staking Pools to inform the validator (us) that a particular amount of total stake has been removed
     * from the specified pool.  This is used to update the stats we have in our PoolInfo storage.
     * The calling App ID is validated against our pool list as well.
     * @param poolKey - ValidatorPoolKey type - [validatorID, PoolID] compound type
     * @param staker
     * @param amountRemoved
     * @param stakerRemoved
     */
    stakeRemoved(poolKey: ValidatorPoolKey, staker: Address, amountRemoved: uint64, stakerRemoved: boolean): void {
        assert(this.ValidatorList(poolKey.ID).exists);
        assert((poolKey.PoolID as uint64) < 2 ** 16); // since we limit max pools but keep the interface broad
        assert(poolKey.PoolID > 0 && (poolKey.PoolID as uint16) <= this.ValidatorList(poolKey.ID).value.State.NumPools);
        // validator id, pool id, pool app id might still be kind of spoofed but they can't spoof us verifying they called us from
        // the contract address of the pool app id they represent.
        assert(
            poolKey.PoolAppID === this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].PoolAppID,
            "The passed in app id doesn't match the passed in ids"
        );
        // Sender has to match the pool app id passed in as well.
        assert(this.txn.sender === Application.fromID(poolKey.PoolAppID).address);
        // verify its state is right as well
        assert(poolKey.ID === (Application.fromID(poolKey.PoolAppID).globalState('validatorID') as uint64));
        assert(poolKey.PoolID === (Application.fromID(poolKey.PoolAppID).globalState('poolID') as uint64));

        // Remove the specified amount of stake - update pool stats, then total validator stats
        this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].TotalAlgoStaked -= amountRemoved;
        this.ValidatorList(poolKey.ID).value.State.TotalAlgoStaked -= amountRemoved;
        if (stakerRemoved) {
            this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].TotalStakers -= 1;
            this.ValidatorList(poolKey.ID).value.State.TotalStakers -= 1;
            this.removeFromStakerPoolSet(staker, <ValidatorPoolKey>{
                ID: poolKey.ID,
                PoolID: poolKey.PoolID,
                PoolAppID: poolKey.PoolAppID,
            });
        }
    }

    findPoolForStaker(validatorID: ValidatorID, staker: Address, amountToStake: uint64): ValidatorPoolKey {
        // expensive loops - buy it up right now
        increaseOpcodeBudget();

        // We have max per pool per validator - this value is stored in the pools as well and they enforce it on their
        // addStake calls but the values should be the same and we shouldn't even try to add stake if it won't even
        // be accepted.
        const maxPerPool = this.ValidatorList(validatorID).value.Config.MaxAlgoPerPool;
        // If there's already a stake list for this account, walk that first, so if the staker is already in this
        // validator, then go to the stakers existing pool(s) w/ that validator first.
        if (this.StakerPoolSet(staker).exists) {
            const poolSet = clone(this.StakerPoolSet(staker).value);
            for (let i = 0; i < poolSet.length; i += 1) {
                if (poolSet[i].ID === validatorID) {
                    // This staker already has stake with this validator - if room left, start there first
                    if (
                        this.ValidatorList(validatorID).value.Pools[poolSet[i].PoolID - 1].TotalAlgoStaked +
                            amountToStake <
                        maxPerPool
                    ) {
                        return poolSet[i];
                    }
                }
            }
        }

        // We don't already have stake in place, so ensure the stake meets the 'minimum entry' amount
        assert(
            amountToStake >= this.ValidatorList(validatorID).value.Config.MinAllowedStake,
            'must stake at least the minimum for this pool'
        );

        const pools = clone(this.ValidatorList(validatorID).value.Pools);
        for (let i = 0; i < pools.length; i += 1) {
            if (pools[i].TotalAlgoStaked + amountToStake < maxPerPool) {
                return { ID: validatorID, PoolID: i + 1, PoolAppID: pools[i].PoolAppID };
            }
        }
        // Not found is poolID 0
        return { ID: validatorID, PoolID: 0, PoolAppID: 0 };
    }

    private validateConfig(config: ValidatorConfig): void {
        // Verify all the value in the ValidatorConfig are correct
        assert(config.PayoutEveryXDays >= MIN_PAYOUT_DAYS && config.PayoutEveryXDays <= MAX_PAYOUT_DAYS);
        assert(config.PercentToValidator >= MIN_PCT_TO_VALIDATOR && config.PercentToValidator <= MAX_PCT_TO_VALIDATOR);
        assert(config.ValidatorCommissionAddress !== Address.zeroAddress);
        assert(config.MinAllowedStake >= MIN_ALGO_STAKE_PER_POOL);
        assert(config.MaxAlgoPerPool <= MAX_ALGO_PER_POOL, 'enforce hard constraint to be safe to the network');
        assert(config.PoolsPerNode > 0 && config.PoolsPerNode <= MAX_POOLS_PER_NODE);
        assert(config.MaxNodes > 0 && config.MaxNodes <= MAX_NODES);
    }

    /**
     * Adds a stakers amount of algo to a validator pool, transferring the algo we received from them (already verified
     * by our caller) to the staking pool account, and then telling it about the amount being added for the specified
     * staker.
     *
     * @param {PayTxn} stakedAmountPayment - payment coming from staker to place into a pool
     * @param {ValidatorPoolKey} poolKey - The key of the validator pool.
     * @param {uint64} mbrAmtPaid - Amount the user is leaving behind in the validator to pay for their Staker MBR cost
     * @returns {void}
     */
    private callPoolAddStake(stakedAmountPayment: PayTxn, poolKey: ValidatorPoolKey, mbrAmtPaid: uint64) {
        const poolAppID = this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].PoolAppID;
        const priorStakers = Application.fromID(poolAppID).globalState('numStakers') as uint64;

        // forward the payment on to the pool via 2 txns
        // payment + 'add stake' call
        sendMethodCall<[InnerPayment, Address], uint64>({
            name: 'addStake',
            applicationID: Application.fromID(poolAppID),
            methodArgs: [
                // =======
                // THIS IS A SEND of the amount received right back out and into the staking pool contract account.
                { amount: stakedAmountPayment.amount - mbrAmtPaid, receiver: Application.fromID(poolAppID).address },
                // =======
                stakedAmountPayment.sender,
            ],
        });

        this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].TotalStakers = Application.fromID(
            poolAppID
        ).globalState('numStakers') as uint64 as uint16;

        this.ValidatorList(poolKey.ID).value.Pools[poolKey.PoolID - 1].TotalAlgoStaked = Application.fromID(
            poolAppID
        ).globalState('staked') as uint64;

        // now update our global totals based on delta (if new staker was added, new amount - can only have gone up or stayed same)
        this.ValidatorList(poolKey.ID).value.State.TotalStakers +=
            (Application.fromID(poolAppID).globalState('numStakers') as uint64) - priorStakers;

        this.ValidatorList(poolKey.ID).value.State.TotalAlgoStaked += stakedAmountPayment.amount - mbrAmtPaid;
    }

    private updateStakerPoolSet(staker: Address, poolKey: ValidatorPoolKey) {
        if (!this.StakerPoolSet(staker).exists) {
            this.StakerPoolSet(staker).create();
        }
        const poolSet = clone(this.StakerPoolSet(staker).value);
        for (let i = 0; i < this.StakerPoolSet(staker).value.length; i += 1) {
            if (poolSet[i] === poolKey) {
                // already in pool set
                return;
            }
            if (poolSet[i].ID === 0) {
                this.StakerPoolSet(staker).value[i] = poolKey;
                return;
            }
        }
        throw Error('No empty slot available in the staker pool set');
    }

    private removeFromStakerPoolSet(staker: Address, poolKey: ValidatorPoolKey) {
        const poolSet = clone(this.StakerPoolSet(staker).value);
        for (let i = 0; i < this.StakerPoolSet(staker).value.length; i += 1) {
            if (poolSet[i] === poolKey) {
                this.StakerPoolSet(staker).value[i] = { ID: 0, PoolID: 0, PoolAppID: 0 };
                return;
            }
        }
    }
}
