const TIMER = "### AEAT calculation ###";
const helpers = require('./helpers');

const {
  USERNAME,
} = require('./config');

const run = async () => {
  const getEURExchangeRates = async () => {
    const url = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/usd.xml"
    let request = require('unirest').get(url);

    const convertResponse = response => {
      const xml2js = require('xml2js');
      let resultMap = null;
      xml2js.parseString(response.body, (err, result) => {
        if (err) {
          throw err;
        }
        resultMap = result.CompactData.DataSet[0].Series[0].Obs.reduce((map, obj) => {
          map[obj.$.TIME_PERIOD.replace(/-/g, '')] = obj.$.OBS_VALUE;
          return map;
        }, {});
        return true;
      });
      return resultMap;

    };

    return new Promise((resolve, reject) => {
      request.end(function (response) {
        helpers.debug("END getEURExchangeRates ...");
        if (response.error)
          return reject(response.error);
        if (helpers.responseIsOk(response)) {
          helpers.debug("Response OK ...");
          return resolve(convertResponse(response));
        } else {
          return reject("Bad response body!");
        }
      });
    });
  }
  const orderMovementsJSON = (arr) => {
    return arr.sort((a, b) => {
      if (a.Date == b.Date) {
        a_split = a.Hour.split(':');
        b_split = b.Hour.split(':');
        if (a_split[0] == b_split[0]) {
          if (a_split[1] == b_split[1]) {
            return a_split[2] - b_split[2];
          }
          return a_split[1] - b_split[1];
        }
        return a_split[0] - b_split[0];
      }
      return a.Date - b.Date;
    });
  }
  const getMovementsJSON = (csvFilePath) => {
    let csvToJson = require('convert-csv-to-json');
    let jsonArray = csvToJson
      .fieldDelimiter(',')
      .getJsonFromCsv(csvFilePath);

    return jsonArray;
  }
  const getDividendsJSON = () => {
    const csvFilePath = "/Users/jesusmunoz/Desktop/workspace/jesus/node-alerts/src/aeat-calculator/div.csv";
    let csvToJson = require('convert-csv-to-json');
    let jsonArray = csvToJson
      .fieldDelimiter(',')
      .getJsonFromCsv(csvFilePath);

    return jsonArray;
  }
  const getEURUDChangeByDate = (x, ctx) => {
    if (x.Currency == "EUR")
      return 1;
    if (ctx.EURUSDResultmap[x.Date] == undefined) {
      if (x.Date == "20200501") {
        return ctx.EURUSDResultmap["20200430"];
      }
      helpers.error("[ERROR] " + ctx.EURUSDResultmap[x.Date] + ": EURUSDResultmap for " + x.Date + " while processing " + x.Type + "/" + x.Name);
    }
    return ctx.EURUSDResultmap[x.Date];
  }
  const addDividend = (x, ctx) => {
    helpers.currency("[" + x.Date + "] [Dividendo] Nuevo apunte " + x.Type + "/" + x.Name + ": " + x.Price + " bruto " + x.Withhold + " tax = " + (+x.Price + +x.Withhold));
    //let dividendResult = { ingresoIntegro: 0, retenciones: 0, gastos: 0, extranjero: 0, impuestoExtranjero: 0 };
    // Suma de todos los dividendos recibidos. Extranjeros y Españoles. En euros y cantidad bruta
    ctx.dividendResult.ingresoIntegro += x.Price / getEURUDChangeByDate(x, ctx);
    if (x.Name == "FRA:H4ZM") {
      // Retenciones: la retención practicada en destino. Extranjeros y Españoles. En euros
      ctx.dividendResult.retenciones += x.Withhold / getEURUDChangeByDate(x, ctx);
    }
    if (x.Currency == "USD") {
      // Rendimientos netos reducidos del capital mobiliario obtenidos en el extranjeros incluidos en la base del ahorro
      // la suma de todos los dividendos extranjeros brutos menos los de UK (o cualquier otro cuya retención de ORIGEN sea 0). En Euros.
      ctx.dividendResult.extranjero += x.Price / getEURUDChangeByDate(x, ctx);
      // Impuesto satisfecho en el extranjero
      // 588 – Deducciones por doble imposición internacional, por razón de las rentas obtenidas y gravadas en el extranjero
      ctx.dividendResult.impuestoExtranjero += x.Withhold / getEURUDChangeByDate(x, ctx);
    }

    return;
  }
  const addCurrencyFIFO = (x, ctx) => {
    const amount = Math.abs(x.Price * x.Shares * x.Mult) - Math.abs(x.Fee);
    if (amount <= 0) return;
    ctx.currencyFIFO.push({
      amount: amount,
      source: x
    });
    helpers.currency("[" + x.Date + "] [Moneda] Nuevo apunte " + x.Type + "/" + x.Name + ": " + amount + " @ " + (x.Type == "CASH_TRD" ? x.Price : getEURUDChangeByDate(x, ctx)));
    return;
  }
  const removeCurrencyFIFO = (x, amount, ctx) => {
    const fifoAmount = ctx.currencyFIFO[0];
    if (fifoAmount.amount == 0 || amount == 0) return;
    if (amount >= fifoAmount.amount) {
      printCurrencyOperationResult(x, fifoAmount.amount, fifoAmount, "[Moneda] Cancelado total posicion fifo (quedan por cancelar " + (amount - fifoAmount.amount) + ") ", ctx);
      ctx.currencyFIFO.splice(0, 1);
      //helpers.currency("[" + x.Date + "] [Moneda] Cancelado total apunte " + fifoAmount.source.Type + "/" + fifoAmount.source.Name + " [" + fifoAmount.source.Date + "]: " + fifoAmount.amount + " @ " + getEURUDChangeByDate(x, ctx));
      removeCurrencyFIFO(x, amount - fifoAmount.amount, ctx);
    } else {
      printCurrencyOperationResult(x, amount, fifoAmount, "[Moneda] Cancelado parcial posicion fifo, quedan " + (fifoAmount.amount - amount) + " en el apunte", ctx);
      //helpers.currency("[" + x.Date + "] [Moneda] Cancelado parcial (quedan " + (fifoAmount.amount - amount) + ") apunte " + fifoAmount.source.Type + "/" + fifoAmount.source.Name + " [" + fifoAmount.source.Date + "]: " + amount + " @ " + getEURUDChangeByDate(x, ctx));
      fifoAmount.amount -= amount;
    }
    return;
  }
  const printCurrencyOperationResult = (x, amount, fifoAmount, msg, ctx) => {
    const buyChangeRate = fifoAmount.source.Type == "CASH_TRD" ? fifoAmount.source.Price : getEURUDChangeByDate(fifoAmount.source, ctx);
    const buyPriceEUR = Math.abs(amount) / buyChangeRate;
    const sellPriceEUR = Math.abs(amount) / getEURUDChangeByDate(x, ctx);
    ctx.currencyResult.buyPriceEUR += buyPriceEUR;
    ctx.currencyResult.sellPriceEUR += sellPriceEUR;
    if (fifoAmount.source.Type == "CASH_TRD" && amount >=fifoAmount.amount) {
      ctx.currencyResult.buyFeeEUR += +fifoAmount.source.Fee;
    }
    helpers.currency("[" + x.Date + "] " + msg + " " + fifoAmount.source.Type + "/" + fifoAmount.source.Name + " [" + fifoAmount.source.Date + "]: " + amount + " @ " + buyChangeRate);
    helpers.currency("  --> buyPriceEUR = " + Math.abs(amount).toFixed(2).toString() + "/" + buyChangeRate + " = " + buyPriceEUR);
    helpers.currency("  --> sellPriceEUR = " + Math.abs(amount).toFixed(2).toString() + "/" + getEURUDChangeByDate(x, ctx) + " = " + sellPriceEUR);
    helpers.currency("  --> P/G = " + sellPriceEUR.toFixed(2).toString() + "-" + buyPriceEUR.toFixed(2).toString() + " = " + (sellPriceEUR - buyPriceEUR) + " EUR");
    return;
  }
  const printOperationResult = (x, y, sharesX, sharesY, msg, ctx) => {
    if (x.Action.startsWith("SELL")) {
      if (y.Action.startsWith("SELL")) {
        helpers.error("[ERROR] Double SELL operation" + x.Type + x.Name);
      }
      return printOperationResult(y, x, sharesY, sharesX, msg, ctx);
    }
    const buyPriceEUR = Math.abs(x.Price * sharesX * x.Mult) / getEURUDChangeByDate(x, ctx);
    const buyFeeEUR = Math.abs(x.Shares) == Math.abs(sharesX) ? x.Fee / getEURUDChangeByDate(x, ctx) : 0;
    const sellPriceEUR = Math.abs(y.Price * sharesY * y.Mult) / getEURUDChangeByDate(y, ctx);
    const sellFeeEUR = Math.abs(y.Shares) == Math.abs(sharesY) ? y.Fee / getEURUDChangeByDate(y, ctx) : 0;
    if (x.Type == "OPT_TRD") {
      ctx.optionResult.buyPriceEUR += buyPriceEUR;
      ctx.optionResult.buyFeeEUR += buyFeeEUR;
      ctx.optionResult.sellPriceEUR += sellPriceEUR;
      ctx.optionResult.sellFeeEUR += sellFeeEUR;
      msg = msg.replace("Stock", "Option");
    } else if (x.Type == "STK_TRD") {
      ctx.stockResult.buyPriceEUR += buyPriceEUR;
      ctx.stockResult.buyFeeEUR += buyFeeEUR;
      ctx.stockResult.sellPriceEUR += sellPriceEUR;
      ctx.stockResult.sellFeeEUR += sellFeeEUR;
    } else {
      helpers.error("[ERROR] Type=" + x.Type);
    }
    helpers.stock("[" + x.Date + "] " + msg + " " + x.Type + "/" + x.Name + ": " + sharesX + "x" + Math.abs(x.Price * x.Mult) + " = " + Math.abs(x.Price * sharesX * x.Mult) + " @ " + getEURUDChangeByDate(x, ctx));
    helpers.stock("  --> buyPriceEUR = " + Math.abs(x.Price * sharesX * x.Mult).toFixed(2).toString() + "/" + getEURUDChangeByDate(x, ctx) + " = " + buyPriceEUR);
    helpers.stock("  --> sellPriceEUR = " + Math.abs(y.Price * sharesY * y.Mult).toFixed(2).toString() + "/" + getEURUDChangeByDate(y, ctx) + " = " + sellPriceEUR);
    helpers.stock("  --> P/G = " + sellPriceEUR.toFixed(2).toString() + "-" + buyPriceEUR.toFixed(2).toString() + (Math.sign(sellFeeEUR) >= 0 ? "+" : "") + sellFeeEUR.toFixed(2).toString() + (Math.sign(buyFeeEUR) >= 0 ? "+" : "") + buyFeeEUR.toFixed(2).toString() + " = " + (sellPriceEUR - buyPriceEUR + sellFeeEUR + buyFeeEUR) + " EUR");
    return;
  }
  const addStockFIFO = (x, ctx) => {
    ctx.stockFIFO.push(x);
    helpers.stock("[" + x.Date + "] [Stock] Nuevo apunte " + x.Type + "/" + x.Name + ": " + x.Shares + "x" + Math.abs(x.Price * x.Mult) + " = " + Math.abs(x.Price * x.Shares * x.Mult) + " @ " + getEURUDChangeByDate(x, ctx));
    return;
  }
  const removeStockFIFO = (x, ctx, includeCurrency) => {
    const idx = ctx.stockFIFO.findIndex(y => x.Name == y.Name);
    if (idx == -1) {
      helpers.warning("Movement unmatched");
      return;
    }
    const fifoShares = Math.abs(ctx.stockFIFO[idx].Shares);
    const movShares = Math.abs(x.Shares);
    if (fifoShares == movShares) {
      printOperationResult(x, ctx.stockFIFO[idx], movShares, movShares, "[Stock] Cancelado total apunte", ctx);
      ctx.stockFIFO.splice(idx, 1);
      //helpers.stock("[" + x.Date + "] [Stock] Cancelado total apunte " + x.Type + "/" + x.Name + ": " + x.Shares + "x" + Math.abs(x.Price * x.Shares * x.Mult) + " @ " + getEURUDChangeByDate(x, ctx));
      if (includeCurrency) {
        removeCurrencyFIFO(x, (x.Price * movShares * x.Mult) + +x.Fee, ctx);
      }
    } else if (fifoShares > movShares) {
      //no contar fee del fifoShares, ya que no se cancela
      printOperationResult(x, ctx.stockFIFO[idx], movShares, movShares, "[Stock] Cancelado parcial apunte", ctx);
      ctx.stockFIFO[idx].Shares = +ctx.stockFIFO[idx].Shares + +x.Shares
      //helpers.stock("[" + x.Date + "] [Stock] Cancelado parcial apunte " + x.Type + "/" + x.Name + ": " + x.Shares + "x" + Math.abs(x.Price * x.Shares * x.Mult) + " @ " + getEURUDChangeByDate(x, ctx));
      if (includeCurrency) {
        removeCurrencyFIFO(x, (x.Price * movShares * x.Mult) + +x.Fee, ctx);
      }
    } else if (fifoShares < movShares) {
      //no contar fee del movShares, ya que no se cancela
      printOperationResult(x, ctx.stockFIFO[idx], fifoShares, fifoShares, "[Stock] Cancelado total apunte", ctx);
      x.Shares = +ctx.stockFIFO[idx].Shares + +x.Shares
      ctx.stockFIFO.splice(idx, 1);
      //helpers.stock("[" + x.Date + "] [Stock] Cancelado total apunte " + x.Type + "/" + x.Name + ": " + fifoShares + "x" + Math.abs(x.Price * fifoShares * x.Mult) + " @ " + getEURUDChangeByDate(x, ctx));
      helpers.debug("Partial close!, keep looking");
      if (includeCurrency) {
        removeCurrencyFIFO(x, x.Price * fifoShares * x.Mult, ctx);
      }
      processMovement(x, ctx);
    } else {
      helpers.error("IMPOSSIBLE: Partial close!");
    }
    return;
  }
  const processMovement = (x, ctx) => {
    if (x.Type == "DIV_USD") {
      addDividend(x, ctx);
      addCurrencyFIFO(x, ctx);
      return;
    }
    if (x.Type == "DIV_EUR") {
      addDividend(x, ctx);
      return;
    }
    if (x.Type == "CASH_TRD") {
      if (x.Action == "SELLTOOPEN") {
        addCurrencyFIFO(x, ctx);
        return;
      }
    }
    if (x.Type == "OPT_TRD" || x.Type == "STK_TRD") {
      if (x.Action == "SELLTOOPEN") {
        addStockFIFO(x, ctx);
        addCurrencyFIFO(x, ctx);
        return;
      }
      if (x.Action == "BUYTOOPEN") {
        addStockFIFO(x, ctx);
        if (x.Currency == "USD") {
          helpers.debug("Warning: Posible diferido moneda @ " + x.Name);
          removeCurrencyFIFO(x, x.Price * x.Shares * x.Mult, ctx);
        }
        return;
      }
      if (x.Action == "SELLTOCLOSE") {
        removeStockFIFO(x, ctx, false);
        if (x.Currency == "USD") {
          addCurrencyFIFO(x, ctx);
        }
        return;
      }
      if (x.Action == "BUYTOCLOSE") {
        removeStockFIFO(x, ctx, true);
        return;
      }
    }
    helpers.error("Not implemented: " + x.Type + "/" + x.Action);
  }

  console.time(TIMER);
  helpers.notice('=== Starting AEAT calculation for 2020 ===');
  const EURUSDResultmap = await getEURExchangeRates();
  const dividends = getDividendsJSON();
  const csvFilePath = "/Users/jesusmunoz/Desktop/workspace/jesus/node-alerts/src/aeat-calculator/mov.csv";
  let movements = getMovementsJSON(csvFilePath);
  const csvFilePathEUR = "/Users/jesusmunoz/Desktop/workspace/jesus/node-alerts/src/aeat-calculator/movEUR.csv";
  getMovementsJSON(csvFilePathEUR).forEach(x => movements.push(x));
  dividends.forEach(x => {
    x.Type = x.Currency == "USD" ? "DIV_USD" : "DIV_EUR";
    x.Name = x.Symbol;
    x.Date = x.ReportDate;
    x.Hour = "00:00:00";
    x.Shares = 1;
    x.Mult = 1;
    x.Price = x.Gross;
    x.Fee = x.Withhold;
    movements.push(x);
  });
  let currencyFIFO = [];
  let stockFIFO = [];
  let stockResult = { buyPriceEUR: 0, buyFeeEUR: 0, sellPriceEUR: 0, sellFeeEUR: 0 };
  let optionResult = { buyPriceEUR: 0, buyFeeEUR: 0, sellPriceEUR: 0, sellFeeEUR: 0 };
  let currencyResult = { buyPriceEUR: 0, buyFeeEUR: 0, sellPriceEUR: 0, sellFeeEUR: 0 };
  let dividendResult = { ingresoIntegro: 0, retenciones: 0, gastos: 10, extranjero: 0, impuestoExtranjero: 0 };
  movements = orderMovementsJSON(movements);
  movements.forEach(x => processMovement(x, { EURUSDResultmap, currencyFIFO, stockFIFO, stockResult, optionResult, currencyResult, dividendResult }));
  helpers.notice("optionResult: " + JSON.stringify(optionResult));
  helpers.notice("stockResult: " + JSON.stringify(stockResult));
  helpers.notice("currencyResult: " + JSON.stringify(currencyResult));
  helpers.notice("dividendResult: " + JSON.stringify(dividendResult));
  helpers.notice("stockFIFO: ");
  stockFIFO.forEach(x => helpers.notice(x.Shares + " x " + x.Name));
  helpers.notice("currencyFIFO: ");
  currencyFIFO.forEach(x => helpers.notice("[" + x.source.Date + "] " + x.amount + " x " + x.source.Name));

  console.timeEnd(TIMER);
}

run();