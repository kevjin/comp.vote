import {
  COMP_ABI,
  SIG_RELAYER_ABI,
  GOVERNOR_BRAVO_ABI,
  SIG_RELAYER_ADDRESS,
  COMP_ADDRESS,
  GOVERNANCE_ADDRESS,
  MULTICALL_ABI,
  MULTICALL_ADDRESS
} from "helpers/abi"; // Contract ABIs + Addresses
import {
  insertDelegateTx,
  insertVoteTx,
  delegationAllowed,
  voteAllowed,
  pendingTransactions,
} from "helpers/database/awaitingTxs"; // Database helper functions
import Web3 from "web3"; // Web3
import axios from "axios"; // Axios requests
import { recoverTypedSignature } from "@metamask/eth-sig-util"; // EIP-712 sig verification

/**
 * Instantiates server-side web3 connection
 */
export const Web3Handler = () => {
  // Setup web3 handler
  const web3 = new Web3(process.env.NEXT_PUBLIC_INFURA_RPC);

  // Setup contracts
  const sigRelayer = new web3.eth.Contract(
    SIG_RELAYER_ABI,
    SIG_RELAYER_ADDRESS
  );
  const compToken = new web3.eth.Contract(COMP_ABI, COMP_ADDRESS);
  const governorBravo = new web3.eth.Contract(
    GOVERNOR_BRAVO_ABI,
    GOVERNANCE_ADDRESS
  );
  const multicall = new web3.eth.Contract(MULTICALL_ABI, MULTICALL_ADDRESS);

  // Return web3 + contracts
  return {
    web3,
    sigRelayer,
    compToken,
    governorBravo,
    multicall
  };
};

/**
 * Generate voting message
 * @param {Number} proposalId for Compound Governance proposal
 * @param {boolean} support for or against
 */
const createVoteBySigMessage = (proposalId, support) => {
  // Types
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Ballot: [
      { name: "proposalId", type: "uint256" },
      { name: "support", type: "uint8" },
    ],
  };

  // Return message to sign
  return {
    types,
    primaryType: "Ballot",
    // Compound Governor contract
    domain: {
      name: "Compound Governor Bravo",
      chainId: 1,
      verifyingContract: "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
    },
    // Message
    message: {
      proposalId,
      support: support,
    },
  };
};

/**
 * Generate delegation message
 * @param {string} delegatee address to delegate voting power to
 * @param {integer} nonce transaction nonce
 */
const createDelegateBySigMessage = (delegatee, nonce, expiry) => {
  // Types
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Delegation: [
      { name: "delegatee", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
  };

  // Return message to sign
  return {
    types,
    primaryType: "Delegation",
    // Compound COMP token contract
    domain: {
      name: "Compound",
      chainId: 1,
      verifyingContract: "0xc00e94cb662c3520282e6f5717214004a7f26888",
    },
    // Message
    message: {
      // Delegatee address
      delegatee,
      nonce: nonce,
      expiry: expiry,
    },
  };
};

/**
 * Checks if address can delegate by sig to given delegatee
 * @param {String} address to delegate from
 * @param {String} delegatee address to delegate to (optional)
 */
const canDelegate = async (address, delegatee = "0x") => {
  // Collect COMP token contract
  const { web3, compToken } = Web3Handler();

  // Delegatee and address formatting
  delegatee = delegatee.toString().toLowerCase();
  address = address.toString().toLowerCase();

  // Check for address
  if (address === undefined) {
    const error = new Error("invalid address input");
    error.code = 422;
    throw error;
  }

  if (delegatee != "0x") {
    // Address set, must be valid
    if (!web3.utils.isAddress(delegatee)) {
      // Invalid address
      const newError = new Error("invalid delegatee address");
      newError.code = 422;
      throw newError;
    }
  }

  if (!web3.utils.isAddress(address)) {
    const newError = new Error("invalid from address");
    newError.code = 422;
    throw newError;
  }

  // Gets the address onchain COMP balance, current address
  // delegated to and checks if database for delegationAllowed
  let compBalance, currentDelegatee;

  try {
    [compBalance, currentDelegatee] = await Promise.all([
      // Collect address COMP balance
      compToken.methods.balanceOf(address).call(),
      // Collect address delegated status
      compToken.methods.delegates(address).call(),
      // Collect database for delegationAllowed
      delegationAllowed(address),
    ]);
  } catch (error) {
    // If error from database
    if (typeof error.code == "number") {
      // Return error
      throw error;
    }

    // Else, return blockchain error
    const newError = new Error("error fetching data from blockchain");
    newError.code = 500;
    throw newError;
  }

  // Enforces a min COMP balance
  if (parseInt(compBalance) < parseInt(process.env.MIN_COMP)) {
    const error = new Error("COMP balance too low");
    error.code = 403;
    throw error;
  }

  // If delegatee is specified, must not match existing delegatee
  if (
    delegatee != "0x" &&
    delegatee.localeCompare(currentDelegatee.toString().toLowerCase()) == 0
  ) {
    const error = new Error("delegatee can not be current delegatee");
    error.code = 403;
    throw error;
  }
};

/**
 * Checks if an address can vote by sig for the given proposal
 * @param {String} address
 * @param {Number} proposalId
 */
const canVote = async (address, proposalId) => {
  // Collect Web3 + contracts
  const { web3, compToken, governorBravo } = Web3Handler();

  // Check for undefined inputs
  if (typeof address == "undefined" || typeof proposalId == "undefined") {
    const error = new Error("invalid input");
    error.code = 422;
    throw error;
  }

  // Force address formatting
  address = address.toString().toLowerCase();

  if (!web3.utils.isAddress(address)) {
    const newError = new Error("invalid from address");
    newError.code = 422;
    throw newError;
  }

  // On chain proposal data
  let proposal;
  // On chain votes delegated at start of proposal
  let votesDelegated;
  // Address proposal receipt. Stores voting status
  let receipt;
  // Current chain block
  let currentBlock;

  try {
    [proposal, receipt, currentBlock] = await Promise.all([
      // Collect proposal data
      governorBravo.methods.proposals(proposalId).call(),
      // Collect proposal receipt
      governorBravo.methods.getReceipt(proposalId, address).call(),
      // Collect current block number
      web3.eth.getBlockNumber(),
      // Check if vote is allowed from db
      voteAllowed(address, proposalId),
    ]);

    // Check prior delegated votes
    votesDelegated = await compToken.methods
      .getPriorVotes(address, proposal.startBlock)
      .call();
  } catch (erorr) {
    // Error thrown from DB vote allowed. Throw to res
    if (typeof erorr.code == "number") {
      throw erorr;
    }

    // Else, throw blockchain error
    const newError = new Error("error fetching data from blockchain");
    newError.code = 500;
    throw newError;
  }

  // Not ongoing proposal. Leaves a 5 block buffer for last minute relay
  if (
    !(
      currentBlock > proposal.startBlock &&
      currentBlock < proposal.endBlock - 2025
    ) ||
    proposal.canceled
  ) {
    const error = new Error("proposal voting period is not active");
    error.code = 400;
    throw error;
  }

  // Require at least min comp COMP delegated
  if (parseInt(votesDelegated) < parseInt(process.env.MIN_COMP)) {
    const error = new Error("COMP delegated to address is too low");
    error.code = 403;
    throw error;
  }

  // Check address has not voted yet
  if (receipt.hasVoted) {
    const error = new Error("address already voted");
    error.code = 400;
    throw error;
  }
};

/**
 * Validates the given vote by sig data and saves it to the database
 * @param {String} address that created the signature
 * @param {Number} proposalId to vote on
 * @param {bool} support
 * @param {String} v
 * @param {String} r
 * @param {String} s
 */
const vote = async (address, proposalId, support, v, r, s) => {
  // Setup contracts
  const { sigRelayer } = Web3Handler();

  // Check for undefined inputs
  if ([address, proposalId, support, v, r, s].includes(undefined)) {
    const error = new Error("invalid input");
    error.code = 422;
    throw error;
  }

  if (support > 2) {
    const error = new Error("invalid support value");
    error.code = 422;
    throw error;
  }

  if (v == "0x00" || v == "0x01") {
    const error = new Error("invalid signature v input");
    error.code = 422;
    throw error;
  }

  // Force address formatting
  address = address.toString().toLowerCase();

  // Address verified used to create signature
  let sigAddress;
  const data = createVoteBySigMessage(proposalId, support);
  try {
    sigAddress = await recoverTypedSignature({
      data: data,
      signature: r + s.substring(2) + v.substring(2),
      version: "V4",
    });
  } catch (err) {
    const newErr = new Error("invalid signature");
    newErr.code = 422;
    throw newErr;
  }

  // Force address formatting
  sigAddress = sigAddress.toString().toLowerCase();

  // Address verified to create sig and alleged must match
  if (address.localeCompare(sigAddress) != 0) {
    const error = new Error("invalid signature");
    error.code = 422;
    throw error;
  }

  try {
    await canVote(address, proposalId);
  } catch (error) {
    // Pass error from db
    if (typeof error.code == "number") {
      throw error;
    }
    // Else, send error from database
    const newError = new Error("error fetching data from blockchain");
    newError.code = 500;
    throw newError;
  }

  // Create new transactions
  const newTx = {
    from: address,
    v,
    r,
    s,
    support,
    proposalId,
    type: "vote",
    createdAt: new Date(),
    executed: false,
  };

  // Insert vote transaction to db
  await insertVoteTx(newTx);

  // Send notification to admin using telegram
  if (typeof process.env.NOTIFICATION_HOOK != "undefined") {
    await axios.get(process.env.NOTIFICATION_HOOK + "New comp.vote voting sig");
  }
};

/**
 * Validates the given delegate by sig data and saves it to the database
 * @param {String} address that created the signature
 * @param {String} delegatee to delegate to
 * @param {Number} nonce
 * @param {Number} expiry UNIX time when signature expires
 * @param {String} v
 * @param {String} r
 * @param {String} s
 */
const delegate = async (address, delegatee, nonce, expiry, v, r, s) => {
  // Setup contracts
  const { sigRelayer } = Web3Handler();

  // Validate input data
  if ([address, delegatee, nonce, expiry, v, r, s].includes(undefined)) {
    const error = new Error("invalid input");
    error.code = 422;
    throw error;
  }

  // Force address formatting
  address = address.toString().toLowerCase();
  delegatee = delegatee.toString().toLowerCase();

  // Address verified used to create signature
  let sigAddress;
  const data = createDelegateBySigMessage(delegatee, nonce, expiry);

  try {
    sigAddress = await recoverTypedSignature({
      data: data,
      signature: r + s.substring(2) + v.substring(2),
      version: "V4",
    });
  } catch (err) {
    const newErr = new Error("invalid signature");
    newErr.code = 422;
    throw newErr;
  }

  // Force address formatting
  sigAddress = sigAddress.toString().toLowerCase();

  // Address verified to create sig and alleged must match
  if (sigAddress.localeCompare(address) != 0) {
    const error = new Error("given address does not match signer address");
    error.code = 422;
    throw error;
  }

  try {
    await canDelegate(address, delegatee);
  } catch (error) {
    // Return error from db
    if (typeof error.code == "number") {
      throw error;
    }

    // Else, return blockchain error
    const newError = new Error("error fetching data from blockchain");
    newError.code = 500;
    throw newError;
  }

  // Create transaction
  const newTx = {
    from: address,
    delegatee,
    v,
    r,
    s,
    nonce,
    expiry,
    type: "delegate",
    createdAt: new Date(),
    executed: false,
  };

  // Insert transaction into db
  await insertDelegateTx(newTx);

  // Send notification to admin using telegram
  if (typeof process.env.NOTIFICATION_HOOK != "undefined") {
    await axios.get(
      process.env.NOTIFICATION_HOOK + "New comp.vote delegation sig"
    );
  }
};

const getPendingTransactions = async () => {
  return await pendingTransactions();
};

// Export functions
export { canDelegate, canVote, vote, delegate, getPendingTransactions };
