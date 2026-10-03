/* Store settings. Edit these values to change the shop. */
window.QE_CONFIG = {
  storeName: 'Quartz Eon',

  // Prices are entered in rupees. Dollar amounts are worked out from the live USD to LKR rate.
  currencySymbol: 'Rs.',

  // Rupees per US dollar. Only used when the live rate cannot be loaded.
  fallbackUsdRate: 330,

  // What a seller pays each month once their store is approved (in rupees).
  sellerMonthlyFee: 500,

  // Category chips, and the categories a seller can pick when adding a product.
  categories: ['VPN', 'Premium accounts', 'Templates', 'E-books', 'Courses', 'Software', 'Design assets'],

  // The bot's username (without the @). Sellers open it from their dashboard to connect Telegram.
  telegramBot: 'quartzeon_alerts_bot',

  // Set to true once Google log in is switched on in Supabase (see README.md). Shows "Continue with Google".
  googleLogin: true,

  // PayPal (optional): paste your PayPal REST app "Client ID" here (safe to be public; the secret goes into
  // the Edge Function secrets, see README.md). PayPal money goes to YOUR PayPal account, not to the seller.
  // Leave empty to switch PayPal off. Bank transfers are paid to each seller's own bank details.
  paypalClientId: ''
};
