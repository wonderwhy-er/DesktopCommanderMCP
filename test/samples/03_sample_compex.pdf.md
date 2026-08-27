# arXiv:2302.11942v3 [q-fin.MF] 10 Mar 2023 

## Liquidity Providers Greeks and Impermanent Gain 

### Niccolò Bardoscia, Alessandro Nodari ∗ 

### 23 February 2023 

## Abstract 

 In traditional finance, the Black & Scholes model has guided almost 50 years of derivatives pricing, defining a standard to model any volatility-based product. With the rise of Decentralized Finance (DeFi) and constant product Automated Market Makers (AMMs), Liquidity Providers (LPs) are playing an increasingly important role in markets functioning, but, as the recent bear market highlighted, they are exposed to important risks such as Impermanent Loss (IL). In this paper, we tailor the formulas introduced by Black & Scholes to DeFi, proposing a method to calculate the greeks of an LP. We also introduce Impermanent Gain, a product that LPs can use to hedge their position and traders can use to bet on a rise in volatility and benefit from large market moves. 

 Keywords: liquidity providers, impermanent loss, constant product automated market makers, impermanent gain 

 ∗The authors are greteful to 0xSami_, Andrea Bugin, Andrea Prampolini, Barry Fried, Carlo Sala, Fabio Bellini, Giulio Anselmi and Miguel Ottina for providing valuable feedback on drafts of the article. 


## 1 Introduction 

Before diving deeper on the subjects of this article we will present, in this first section, a brief review of the ecosystem in which we will operate and of its principal actors. 

### 1.1 Decentralized Exchanges 

A Decentralized Exchange (DEX) is a peer-to-peer marketplace where transactions occur directly between crypto traders. DEXs fulfill one of crypto’s core possibilities: fostering financial transactions that aren’t officiated by banks, brokers, payment processors, or any other kind of intermediary. The most popular DEXs, like Uniswap and Sushiswap, utilize the Ethereum blockchain and are part of the growing suite of DeFi tools which make a huge range of financial services available directly from a compatible crypto wallet. Unlike Centralized Exchanges (CEXs) like Binance and Coinbase, DEXs don’t allow for exchanges between fiat and crypto. All the transactions in a CEX are handled by the exchange itself via an order book that establishes the price for a particular cryptocurrency based on current buy and sell orders. DEXs, on the other hand, are simply a set of smart contracts: they establish the prices of various cryptocurrencies against each other algorithmically and use Liquidity Pools, in which investors lock funds in exchange for a percentage of the trading fees, in order to facilitate trades. While transactions on a CEX are recorded on that exchange’s internal database, DEX transactions are settled directly on the blockchain. DEXs are usually built on open-source code and developers can adapt existing code to create new competing projects. 

### 1.2 Liquidity Provider 

A Liquidity Provider in crypto, from here on LP, is an investor (individual or institution) who, as the name suggests, funds a liquidity pool with crypto assets it owns in order to facilitate trading on the platform and earn passive income on its deposit. The more assets in a pool, the more liquidity the pool has, and the easier trading becomes on a DEX for other market participants hence the crucial role played by LPs. How much the DEX pays the LP is based on the percentage of the crypto liquidity pool it puts, the volume, and the transaction fee offered by the exchange to LPs. 

1.2.1 Liquidity Provider Tokens 

Liquidity Provider tokens (LP tokens) are crypto tokens given to users who deposit their crypto into a Liquidity Pool. LP tokens represent the Liquidity Provider’s share of the pool and can be redeemed at any time for the underlying assets. Some platforms require LP tokens to be locked for a period of time in order to access additional rewards (Liquidity Mining). 

### 1.3 Constant product AMM 

Here we will present in brief what is a constant product AMM for a more in depht analysis of AMM see for example [1], [2], [3] and [4]. A constant product AMM is a type of AMM in which the reserves of tokens are regulated by a product function, given two tokens x and y we have that: 

 x · y = k 

Where x and y represent, with an abuse of notation, the quantities of token x and y respectively and k is the constant. For example in Uniswap, see [5] and [6], they call that constant L^2 so that: 

 √ x · y = L 

We will indicate with St the pool price of token x in terms of token y at time t. In this type of AMM we can derive the price as the ratio of the number of token y and of token x at time t: 

 St = 

 yt xt 

Another interesting feature of this type of pools is that knowing in an instant t 0 the following data: 

- the constant of the pool L; 


- the number of token x at time t 0 given by x 0 ; 

- the number of token y at time t 0 given by y 0 ; 

and supposing that there is no injection of new capital in the pool till time T , we can calculate the number of tokens in every time t ∈ [t 0 , T ] as: 

 xt = x 0 

#### √ 

#### S 0 

 St 

 yt = y 0 

#### √ 

 St S 0 

#### (1. 3 .1) 

Having established these properties we can start analyzing how the position of a LP evolves in the pool. At time t 0 , that we will assume without losing of generality that is equal to 0, he deposits a certain quantity of token x and y given by: 

 x 0 = 

#### L 

#### √ 

#### S 0 

 y 0 = L 

#### √ 

#### S 0 

Doing so we have that the constant product is respected. So we can calculate the initial capital invested, in terms of token y, as: 

 V 0 = x 0 S 0 + y 0 = 2L 

#### √ 

#### S 0 

When the price moves the quantity of each token changes according to (1.3.1) so that we have: 

 xt = 

#### L 

#### √ 

 St 

 yt = L 

#### √ 

 St 

And so it also changes the value of the position: 

 VLP (t) = xtSt + yt = 2L 

#### √ 

 St = V 0 

#### √ 

 St S 0 

#### = V 0 

#### √ 

 αt 

Where we have defined αt as the ratio of the change in price. So the P&L of the LP position at time t is: LP (t) = Vt − V 0 = V 0 ( 

#### √ 

 αt − 1) 

What we have ignored till now are the fees that Traders have to pay when they do their swaps. Part of these fees go to the protocol while the remainder is divided between the LPs proportional to the quantity of liquidity they have provided. The fees can be expressed as: 

 Φ(t) = V 0 · φ · t 

Where φ is the expected APY on the specific Liquidity Pool so that the actual payoff should be: 

 VLP (t) = V 0 

#### √ 

 αt + Φ(t) = V 0 ( 

#### √ 

 αt + φt) (1. 3 .2) 

While the final P&L is: LP (t) = V 0 ( 

#### √ 

 αt + φt − 1) 

### 1.4 HODLer 

Before moving on we introduce one last character: the HODLer. In DeFi jargon an HODLer indicates a user that holds its tokens without doing anything. That is to say that given an initial quantity of tokens: 

 x 0 and y 0 

at every time t the HODLer will have: 

 xt = x 0 and yt = y 0 

Thus the position value of an HODLer is determined just by the change in price of the tokens. The position value of an HODLer expressed in terms of token y is given by: 

 VH (t) = x 0 St + y 0 


## 2 Impermanent Loss 

Impermanent Loss (IL) is a known problem affecting the LPs defined as the difference between the return of a LP and that of an equal-weight (with respect to the starting time) HODLer. For a more in depth analysis of it on UniSwap, the most used constant product AMM, see [7] and [8]. We recall the starting quantities of tokens for a LP and hence of an equal-weight HODLer: 

 x 0 = 

#### L 

#### √ 

#### S 0 

 y 0 = L 

#### √ 

#### S 0 

and the values of a LP position and that of an HODLer at time t: 

 VLP (t) = xtSt + yt = 

 LSt √ St 

#### + L 

#### √ 

 St = V 0 

#### √ 

 αt 

 VH (t) = x 0 St + y 0 = 

 LSt √ S 0 

#### + L 

#### √ 

#### S 0 = V 0 

#### ( 

 αt + 1 2 

#### ) 

Now we can compute the IL: 

 IL(t) = VLP (t) − V 0 V 0 

#### − 

 VH (t) − V 0 V 0 

#### = 

 VLP (t) − VH (t) V 0 

#### = 

#### √ 

 αt − αt 2 

#### − 

#### 1 

#### 2 

#### (2.1) 

Formula (2) is the same found in [8]. We can also express that in terms of the token return defining: 

 rt := 

 St S 0 

 − 1 = αt − 1 

Doing so we obtain the following equivalent form: 

 IL(r) = 

#### √ 

 r + 1 − 

 r 2 

#### − 1 (2.2) 

-1.2 -1 (^0 1) Percentage Return 2 3 4 5 -1 -0.8 -0.6 -0.4 -0.2 0 Percentage Loss **Impermanent Loss** We plotted the IL given by formula (2.2). We note that IL(r) ≤ 0 and equal to zero only if the price of token x is exactly the same as its starting price S 0 (r = 0). This tells us that being a LP is always worse than being an HODLer, unless the fees are enough to offset this difference. 

### 2.1 LP as an option seller 

It has been noted, for example in [9], that being a LP, if we consider the IL, is actually the same as being an option seller. In fact we know that we can replicate any given twice differentiable payoff h(x) via the formula: 


 h(ST ) = h(S 0 ) + h′(S 0 )(ST − S 0 ) + 

∫ (^) S 0 0 h′′(K)(K − ST )+dK + ∫ (^) ∞ S 0 h′′(K)(ST − K)+dK In our case we have that our payoff function h is the IL that is: h(x) = 

#### √ 

 x S 0 

#### − 

 x 2 S 0 

#### − 

#### 1 

#### 2 

clearly this function is C∞(R+) so that we can apply the replication formula. First we will compute the first and second derivative of the function:      

 h′(x) = 

#### 1 

#### 2 

#### √ 

 xS 0 

#### − 

#### 1 

#### 2 S 0 

 h′′(x) = − 

#### 1 

 4 x^3 /^2 

#### √ 

#### S 0 

#### < 0 

Thus substituting we obtain: 

 h(ST ) = − 

∫ (^) S 0 0 

#### 1 

#### 4 K^3 /^2 

#### √ 

#### S 0 

 (K − ST )+dK − 

∫ (^) ∞ S 0 

#### 1 

#### 4 K^3 /^2 

#### √ 

#### S 0 

 (ST − K)+dK 

That is to say that we can replicate the IL selling an infinite strip of puts and calls of all strikes with maturity T. 


## 3 LP pricing and Greeks 

On most DEXs like Uniswap, LPs can withdraw their liquidity at any time by redeeming their LP tokens. In this case, the price of the LP position is, as seen in formula (1.3.2), always equal to the value of the underlying assets plus fees: 

 Pt = V 0 ( 

#### √ 

 rt + 1 + φt) = V 0 

#### (√^ 

 St S 0 

 + φt 

#### ) 

Where rt is the return of asset x relative to asset y and φ is the expected APY. 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t 0 5000 10000 15000 Pt **LP Position Price** As we will see below, unlocked liquidity has a positive delta, negative gamma and positive theta, while the vega exposure is zero. This is particularly important when options are used to hedge the position as suggested in [5] and [6]. Options do have a vega exposure, therefore an unlocked LP portfolio combined with a long options position always has a positive vega. 

### 3.1 Unlocked Liquidity Greeks 

3.1.1 Delta 

Delta is defined as the partial derivative of the price of the position (Pt) with respect to the underlying price (St): 

#### ∆LP := 

 ∂Pt ∂St 

#### = 

#### V 0 

#### 2 

#### √ 

 S 0 St 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t 0 20 40 60 80 100 120 140 160 LP **Delta LP** 


3.1.2 Delta 1% 

Delta 1% is defined as the change in price of the position when the underlying price changes by 1%. So we will compute it as: 

 ∆1% LP (St) := ∆LP (St) · 

 St 100 

#### = 

#### V 0 

#### 2 

#### √ 

 St S 0 

#### · 10 −^2 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t 0 10 20 30 40 50 60 70 80 1% LP **Delta 1% LP** 3.1.3 Gamma Gamma is defined as the second partial derivative of the price of the position (Pt) with respect to the underlying price (St). It can also be seen as the partial derivative of Delta with respect to the underlying price: 

#### ΓLP := 

 ∂^2 Pt ∂S t^2 

#### = 

#### ∂∆LP 

 ∂St 

#### = − 

#### V 0 

#### 4 

#### √ 

#### S 0 S 

 3 / 2 t 

We note that ΓLP < 0 and that ΓLP → −∞ when St → 0. 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t -2.5 -2 -1.5 -1 -0.5 0 LP **Gamma LP** 


3.1.4 Gamma 1% 

Gamma 1% is defined as the change of the Delta 1% when the underlying price changes by 1%. So we will compute it as: 

 Γ1% LP (St) = ΓLP (St) · 

#### ( 

 St 100 

#### ) 2 

#### = − 

#### V 0 

#### 4 

#### √ 

 St S 0 

#### · 10 −^4 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t -0.4 -0.35 -0.3 -0.25 -0.2 -0.15 -0.1 -0.05 0 1% LP **Gamma 1% LP** 3.1.5 Vega Vega is defined as the partial derivative of the price of the position with respect to the volatility (σ): νLP := ∂Pt ∂σ 

#### = 0 

3.1.6 Theta 

Theta is defined as the partial derivative of the price of the position (Pt) with respect to time (t): 

#### ΘLP := 

 ∂Pt ∂t 

 = φ · V 0 

3.1.7 Rho 

Rho is defined as the partial derivative of the price of the position (Pt) with respect to the risk-free rate (rf ): 

 ρLP := 

 ∂Pt ∂rf 

#### = 0 

### 3.2 Locked Liquidity Analysis 

From here onwards, we assume that the Liquidity Provider has locked his liquidity until time T , perhaps to access liquidity mining rewards. When he does so, he will no longer be able to redeem the underlying assets until maturity. In this case, the fair price of his position may differ from the value of the underlying assets. As we will see, while unlocked liquidity gives exposure only to delta, gamma and theta, locking the liquidity exposes the holder to additional vega and rho risks. In order to calculate the fair price of the locked LP position we need to know: 

- the maturity T when the liquidity gets unlocked (in years); 

- the current time t (in years); 


- the remaining time τ = T − t (in years); 

- the starting price for the underlying S 0 ; 

- the initial capital invested V 0. 

Similar to Black & Scholes, we assume that the price processes are governed by the following SDEs: 

 dBtx = rxBtx dt dByt = ry Bty dt dSt = μStdt + σStdWt 

Where Bxt is the "bond" process relative to token x with risk free rate rx (we can take for example the APY on lending token x on Aave), Byt is the "bond" process relative to token y with risk free rate ry (analogously we can take the APY on lending token y on Aave), St is the market price of token x in terms of token y determined by the drift μ, the volatility σ and the Brownian Motion (BM) Wt. So this is to say that the price process is a Geometric Brownian Motion (GBM). It is known that we can find a probability Q (risk-free probability) in which we have that the price process follows the following SDE: 

 dSt = (rx − ry )Stdt + σd W˜t 

Where we have that W˜t is another BM given by the Ito formula: 

 d W˜t = dWt − 

 μ − (rx − ry ) σ 

 dt 

We can solve the price process SDE and defining rf := rx − ry we obtain: 

 St = S 0 exp 

#### { 

 rf t − 

#### 1 

#### 2 

 σ^2 t + σ W˜t 

#### } 

We will assume that the liquidity pools are efficient, thanks to the presence of arbitrageurs, so that the pool price of token x in terms of token y is arbitrarily close to the market price, except at most in some instants, so that we can use the market price dynamics also for the pool price dynamics. From here onward we will denote everything in terms of token y. Now we can find the price of a locked liquidity position computing the discounted payoff under Q: 

 Pt = EQ[e−rf^ τ^ VLP (T )] = e−rf^ τ^ EQ 

#### [ 

#### V 0 

#### √ 

#### S 0 

#### √ 

#### ST + Φ(T ) 

#### ] 

 = e−rf^ τ 

#### ( 

#### V 0 

#### √ 

#### S 0 

#### EQ[ 

#### √ 

#### ST ] + Φ(T ) 

#### ) 

Thanks to the property of the GBM we have that: 

#### EQ[ 

#### √ 

#### ST ] = 

#### √ 

 St exp 

#### { 

#### 1 

#### 2 

 rf τ − 

#### 1 

#### 8 

 σ^2 τ 

#### } 

#### (⋆) 

See Appendix A for the full derivation of (⋆). Substituting this into the pricing formula and doing some rearrangements we obtain: 

 Pt = V 0 

#### (√^ 

 St S 0 

 exp 

#### { 

 − τ 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### )} 

 + φT e−rf^ τ 

#### ) 

This is the fair value of the LP position locked until time T , when the expected volatility on the pair of tokens is σ and φ is the expected APY of the pool. 


 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 0 

 5000 

 10000 

 15000 

 Pt 

 LP Position Price 

Plot obtained with the following data: 

- V 0 = 10000, S 0 = 1000; 

- rf = 3%, σ = 70%, φ = 10%; 

- T = 0. 5 , τ = 0. 25. 

All the plots in this section are obtained using the same data. 

### 3.3 Greeks 

3.3.1 Delta 

#### ∆LP = 

#### V 0 

#### 2 

#### √ 

 S 0 St 

 exp 

#### { 

 − τ 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### )} 

We note that ∆LP > 0. 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t 0 20 40 60 80 100 120 140 160 LP **Delta LP** We can see that the delta of a liquidity provider increases when the underlying price S drops and vice versa. 


3.3.2 Delta 1% 

 ∆1% LP (St) = 

#### V 0 

#### 2 

#### √ 

 St S 0 exp 

#### { 

 − τ 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### )} 

#### · 10 −^2 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t 0 10 20 30 40 50 60 70 1% LP **Delta 1% LP** 3.3.3 Gamma 

#### ΓLP = − 

#### V 0 

#### 4 

#### √ 

#### S 0 S 

 3 / 2 t 

 exp 

#### { 

 − τ 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### )} 

We note that ΓLP < 0 and that ΓLP → −∞ when St → 0. 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t -2.5 -2 -1.5 -1 -0.5 0 LP **Gamma LP** 3.3.4 Gamma 1% Γ1% LP (St) = − 

#### V 0 

#### 4 

#### √ 

 St S 0 

 exp 

#### { 

 − τ 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### )} 

#### · 10 −^4 


 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 -0.35 

 -0.3 

 -0.25 

 -0.2 

 -0.15 

 -0.1 

 -0.05 

 0 

 1% LP 

 Gamma 1% LP 

3.3.5 Vega 

 νLP = −V 0 

 στ 4 

#### √ 

 St S 0 

 exp 

#### { 

 − τ 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### )} 

We note that νLP < 0. 

 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 -7 

 -6 

 -5 

 -4 

 -3 

 -2 

 -1 

 0 

 LP 

 Vega LP 

In the figure we have plotted the Vega corresponding to a 1% change in volatility σ, that is ν/ 100. 

3.3.6 Theta 

#### ΘLP = V 0 

#### (√^ 

 St S 0 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 exp 

#### { 

 − τ 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### )} 

 + rf φT e−rf^ τ 

#### ) 


 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 0 

 0.5 

 1 

 1.5 

 2 

 2.5 

 3 

 LP 

 Theta LP 

In the figure we have plotted the daily Theta, that is Θ/ 365. 

3.3.7 Rho 

Even if we have a model with two risk free rates we note that the price depends only on their difference rf so we can study only the sensibility with respect to rf. 

 ρLP := ∂Pt ∂rf 

#### = −V 0 

#### ( 

 τ 2 

#### √ 

 St S 0 

 exp 

#### { 

 − τ 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### )} 

 + τ φT e−rf^ τ 

#### ) 

 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 -20 

 -18 

 -16 

 -14 

 -12 

 -10 

 -8 

 -6 

 -4 

 -2 

 0 

 LP 

 Rho LP 

In the figure we have plotted the Rho corresponding to a 1% change of rf , that is ρ/ 100. 


## 4 Impermanent Gain 

As detailed in the previous section, a LP is exposed to many risks. While it is relatively easy to hedge the Delta, for example shorting futures on the underlying S, we ask ourselves if we can structure a product that hedges all the other greeks, in particular Vega, Gamma and Theta. We call this product Impermanent Gain (IG). IG’s unit payoff is defined as the opposite of IL: 

 IG(r) = 

#### VH − VLP 

#### V 0 

#### = 1 + 

 r 2 

#### − 

#### √ 

 r + 1 

The IG is a product that has some similarities with European options: 

- it has a maturity T ; 

- it has a strike K that is the starting price from which the IG is computed: 

 rt = 

 St K 

#### − 1 

 where rt is used to compute the IG at time t. 

IG payoff with maturity T can be coded into a smart contract making it a DeFi-native product. 

### 4.1 Pricing 

We have seen in Section 2.1 that we can replicate the IL selling an infinite strip of puts and calls and so we can also replicate the IG buying the same portfolio, thus we could price the IG position finding the cost of the replicating portfolio. Instead of doing that we will use a different approach giving a dynamic for the price process of token x, in terms of token y, and using as the price for the IG position the discounted payoff. We will assume the same dynamics and conditions described in Section 3.2 for the market and liquidity pool price processes. Given the following data: 

- maturity T (in years); 

- current time t (in years); 

- time to expiry τ = T − t (in years); 

- strike K = S 0 , that is the starting price of the token; 

- initial capital V 0 ; 

we can calculate the price of the IG strategy at time t as the discounted payoff under the risk-free measure Q: 

 Pt = EQ[e−rf^ τ^ · V 0 · IG(ST )] = EQ 

#### [ 

 e−rf^ τ^ V 0 

#### ( 

#### 1 

#### 2 

#### + 

#### ST 

#### 2 K 

#### − 

#### √ 

#### ST 

#### K 

#### )] 

 Pt = e−rf^ τ^ V 0 

#### ( 

#### 1 

#### 2 

#### + 

#### 1 

#### 2 K 

#### EQ[ST ] − 

#### 1 

#### √ 

#### K 

#### EQ[ 

#### √ 

#### ST ] 

#### ) 

Remembering the properties of the GBM we have: 

 EQ[ST ] = Sterf^ τ^ (•) 

#### EQ[ 

#### √ 

#### ST ] = 

#### √ 

 St exp 

#### { 

#### 1 

#### 2 

 rf τ − 

#### 1 

#### 8 

 σ^2 τ 

#### } 

See Appendix B for the full derivation of (•). Substituting into the price formula and doing some rearrangements we obtain: 

 Pt = V 0 

#### ( 

#### 1 

#### 2 

 e−rf^ τ^ + 

 St 2 K 

#### − 

#### √ 

 St K 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### }) 


 0 500 1000 1500 2000 2500 3000 3500 4000 St 

 0 

 1000 

 2000 

 3000 

 4000 

 5000 

 6000 

 Pt 

 IG Position Price 

Plot obtained with the following data: 

- V 0 = 10000, K = 1000; 

- rf = 3%, σ = 70%; 

- τ = 3657 (seven days). 

All the plots in this section are obtained using the same data. 

### 4.2 Greeks 

4.2.1 Delta 

#### ∆IG = V 0 

#### ( 

#### 1 

#### 2 K 

#### − 

#### 1 

#### 2 

#### √ 

 KSt 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### }) 

We note that the ∆IG(K) > 0. 

 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 -160 

 -140 

 -120 

 -100 

 -80 

 -60 

 -40 

 -20 

 0 

 20 

 IG 

 Delta IG 


4.2.2 Delta 1% 

 ∆1% IG (St) = V 0 

#### ( 

 St 2 K 

#### − 

#### 1 

#### 2 

#### √ 

 St K 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### }) 

#### · 10 −^2 

 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 -15 

 -10 

 -5 

 0 

 5 

 10 

 15 

 20 

 25 

 30 

 1% IG 

 Delta 1% IG 

4.2.3 Gamma 

#### ΓIG = 

 ∂^2 Pt ∂S^2 t 

#### = 

#### V 0 

#### 4 

#### √ 

 KS t^3 /^2 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### } 

We note that ΓIG > 0 and that ΓLP → +∞ when St → 0. 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t 0 0.5 1 1.5 2 2.5 IG **Gamma IG** 4.2.4 Gamma 1% Γ1% IG (St) = 

#### V 0 

#### 4 

#### √ 

 St K 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### } 

#### · 10 −^4 


 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 0 

 0.05 

 0.1 

 0.15 

 0.2 

 0.25 

 0.3 

 0.35 

 0.4 

 1% IG 

 Gamma 1% IG 

4.2.5 Vega 

 νIG = V 0 

 στ 4 

#### √ 

 St K 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### } 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t 0 0.05 0.1 0.15 0.2 0.25 0.3 0.35 0.4 0.45 0.5 IG **Vega IG** In the figure we have plotted the Vega corresponding to a 1% change in volatility σ, that is ν/ 100. 4.2.6 Theta 

#### ΘIG = V 0 

#### ( 

 rf 2 

 e−rf^ τ^ − 

#### √ 

 St K 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### }) 


 0 200 400 600 800 1000 1200 1400 1600 1800 2000 St 

 -3 

 -2.5 

 -2 

 -1.5 

 -1 

 -0.5 

 0 

 0.5 

 IG 

 Theta IG 

In the figure we have plotted the daily Theta, that is Θ/ 365. 

4.2.7 Rho 

ρIG = − 

 V 0 τ 2 

 e−rf^ τ^ + 

 V 0 τ 2 

#### √ 

 St K 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### } 

#### = 

 V 0 τ 2 

#### (√^ 

 St K 

 exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### } 

 − e−rf^ τ 

#### ) 

(^0 200 400 600 800 1000) S 1200 1400 1600 1800 2000 t -1 -0.8 -0.6 -0.4 -0.2 0 0.2 0.4 IG **Rho IG** In the figure we have plotted the Rho corresponding to a 1% change of rx, that is ρ/ 100. 

### 4.3 Impermanent Gain as a Hedging Tool 

Imagine an LP provides $ 10000 of full-range liquidity on Uniswap on the ETH/USDC pair. He then locks his liquidity for 1 year using a liquidity mining platform. ETH price is $ 1000. He wants to hedge his position using Impermanent Gain. We have: 

- V 0 = 10000, S 0 = 1000; 

- rf = 3%, σ = 70%, φ = 10%; 


- T = 1, τ = 1. 

For the IG, the LP chooses a strike K equal to S 0 = 1000 and a maturity of 1 year. We can compute the greeks of this position. 

4.3.1 Delta 

#### ∆ = ∆IG + ∆LP = 

#### V 0 

#### 2 K 

We note that the Delta is a constant determined by the invested capital V 0 and the strike K. In our case we have ∆ = 5. 

4.3.2 Gamma 

 Γ = ΓIG + ΓLP = 0 

Doing this hedge the resulting position is a Gamma-neutral one. 

4.3.3 Vega 

 ν = νIG + νLP = 0 

Doing this hedge the resulting position is a Vega-neutral one. 

4.3.4 Theta 

 ΘIG + ΘLP = V 0 rf 

#### ( 

#### 1 

#### 2 

 + φT 

#### ) 

 e−rf^ τ 

We note that now Theta doesn’t depend on the underlying price St and on the volatility σ. 

4.3.5 Rho 

 ρ = ρIG + ρLP = −V 0 τ 

#### ( 

#### 1 

#### 2 

 + φT 

#### ) 

 e−rf^ τ 

We note that now Rho doesn’t depend on the underlying price St and on the volatility σ. 

As we have seen, for a liquidity provider with locked liquidity, buying Impermanent Gain completely eliminates Gamma and Vega risks as well as significantly reduces Theta and Rho. 

## 5 Conclusion 

In this paper we analyzed the risks of a liquidity provider with a focus on Impermanent Loss, detailing the position greeks under Black & Scholes assumptions. We found that a liquidity provider has a positive Delta, negative Gamma and positive Theta, while the Vega is zero; we also demonstrated that locking the liquidity changes the risk profile of a liquidity provider and introduces a negative Vega risk. Additionally, we introduced Impermanent Gain, a DeFi-native product tailored for liquidity providers’ needs and demonstrated how it can be used to eliminate most financial risks related to providing liquidity. 


## Appendix A 

Recall that: 

 ST = St exp 

#### {( 

 rf − 

 σ^2 2 

#### ) 

 τ + σWτ 

#### } 

 Wτ ∼ N (0, τ ) 

Recall also that given a standard normal distribution Z ∼ N (0, 1) we have that: 

#### E 

#### [ 

 exp{uZ} 

#### ] 

 = exp 

#### { 

 u^2 2 

#### } 

Now we can proceed: 

#### E[ 

#### √ 

#### ST ] = E 

#### [√ 

 St exp 

#### { 

#### 1 

#### 2 

#### ( 

 rf − σ^2 2 

#### ) 

 τ + σ 2 

 Wτ 

#### }] 

#### = 

#### √ 

 St exp 

#### { 

#### 1 

#### 2 

#### ( 

 rf − σ^2 2 

#### ) 

 τ 

#### } 

#### E 

#### [ 

 exp 

#### { 

 σ 2 

#### √ 

 τ Z 

#### }] 

#### =⇒ E[ 

#### √ 

#### ST ] = 

#### √ 

 St exp 

#### { 

 rf 2 

 τ − 

 σ^2 4 

 τ 

#### } 

 exp 

#### { 

 σ^2 8 

 τ 

#### } 

#### = 

#### √ 

 St exp 

#### {( 

 rf 2 

#### − 

 σ^2 8 

#### ) 

 τ 

#### } 

## Appendix B 

Recall that: 

 ST = St exp 

#### {( 

 rf − 

 σ^2 2 

#### ) 

 τ + σWτ 

#### } 

 Wτ ∼ N (0, τ ) 

Recall also that given a standard normal distribution Z ∼ N (0, 1) we have that: 

#### E 

#### [ 

 exp{uZ} 

#### ] 

 = exp 

#### { 

 u^2 2 

#### } 

Now we can proceed: 

#### E[ST ] = E 

#### [ 

 St exp 

#### {( 

 rf − σ^2 2 

#### ) 

 τ + σWτ 

#### }] 

 = St exp 

#### {( 

 rf − σ^2 2 

#### ) 

 τ 

#### } 

#### E 

#### [ 

 exp 

#### { 

 σ 

#### √ 

 τ Z 

#### }] 

 =⇒ E[ST ] = St exp 

#### { 

 rf τ − 

 σ^2 2 

 τ 

#### } 

 exp 

#### { 

 σ^2 2 

 τ 

#### } 

 = Sterf^ τ 


## Appendix C 

The following table is a Greeks comparison between the different strategies. Let’s first define: 

 β := exp 

#### { 

#### − 

#### ( 

 rf 2 

#### + 

 σ^2 8 

#### ) 

 τ 

#### } 

 γ := e−rf^ τ 

 Greeks Unlocked LP Locked LP Impermanent Gain 

 ∆ 2 √VS^00 St 2 √^ VS^00 St β V 0 

#### ( 

 1 2 K −^ 

 β 2 √KSt 

#### ) 

#### ∆1%^ V 20 

#### √ 

 St S 0 ·^10 

 − 2 V 0 2 

#### √ 

 St S 0 β^ ·^10 

− (^2) V 0 

#### ( 

 St 2 K −^ 

 1 2 

#### √ 

 St K β 

#### ) 

#### · 10 −^2 

#### Γ − V^0 

 4 √ S 0 S^3 t/^2 

#### − V^0 

 4 √ KS t^3 /^2 β ∂ 

(^2) Pt ∂S^2 t^ =^ V 0 4 √ KS^3 t/^2 β Γ1%^ − V 40 

#### √ 

 St S 0 ·^10 

− (^4) − V 0 4 

#### √ 

 St S 0 β^ ·^10 

 − 4 V 0 4 

#### √ 

 St K β^ ·^10 

 − 4 

 ν 0 −V 0 στ 4 

#### √ 

 St S 0 β^ V^0 

 στ 4 

#### √ 

 St K β Θ φ · V 0 V 0 

#### (√ 

 St S 0 

#### ( 

 rf 2 +^ 

 σ^2 8 

#### ) 

 β + rf φT γ 

#### ) 

#### V 0 

#### ( 

 rf 2 γ^ − 

#### √ 

 St K 

#### ( 

 rf 2 +^ 

 σ^2 8 

#### ) 

 β 

#### ) 

 ρ 0 −V 0 

#### ( 

 τ 2 

#### √ 

 St S 0 β^ +^ τ φT γ 

#### ) 

 V 0 τ 2 

#### ( 

 β 

#### √ 

 St K −^ γ 

#### ) 


## References 

1. Angeris, Chitra, "Improved Price Oracles: Constant Function Market Makers", June 2020,     arXiv:2003.10001 [q-fin.TR] 

2. Jensen, Pourpouneh, Nielsen, Ross, "THE HOMOGENEOUS PROPERTIES OF AUTOMATED     MARKET MAKERS", arXiv:2105.02782 [q-fin.TR] 

3. Park, Andreas, "Conceptual Flaws of Decentralized Automated Market Making" (April 11, 2022).     Available at SSRN:     https://ssrn.com/abstract=3805750 or [http://dx.doi.org/10.2139/ssrn.3805750](http://dx.doi.org/10.2139/ssrn.3805750) 

4. Clark, Joseph, "The Replicating Portfolio of a Constant Product Market" (March 8, 2020).     Available at SSRN:     https://ssrn.com/abstract=3550601 or [http://dx.doi.org/10.2139/ssrn.3550601](http://dx.doi.org/10.2139/ssrn.3550601) 

5. Adams, Robinson, Zinsmeister, "Uniswap v2 Core", March 2020, available at:     https://uniswap.org/whitepaper.pdf 

6. Adams, Keefer, Robinson, Salem, Zinsmeister, "Uniswap v3 Core", March 2021, available at:     https://uniswap.org/whitepaper-v3.pdf 

7. Aigner, Dhaliwal, "UNISWAP: Impermanent Loss and Risk Profile of a Liquidity Provider",     June 2021, arXiv:2106.14404 [q-fin.TR] 

8. Elsts, "LIQUIDITY MATH IN UNISWAP V3", 30 September 2021, available at:     https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf 

9. Fukasawa, Masaaki and Maire, Basile and Wunsch, Marcus, Weighted variance swaps hedge     against Impermanent Loss (April 27, 2022). Available at SSRN:     https://ssrn.com/abstract=4095029 or [http://dx.doi.org/10.2139/ssrn.4095029](http://dx.doi.org/10.2139/ssrn.4095029) 

10. Black, Scholes, "The Pricing of Options and Corporate Liabilities", Journal of Political Economy     Vol. 81, No. 3 (May - Jun, 1973), pp. 637-654, The University of Chicago Press 


