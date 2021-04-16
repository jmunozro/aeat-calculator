const TIMER = "### AEAT calculation ###";
const helpers = require('./helpers');

const {
  csvFilePathDivArr,
  csvFilePathArr,
  startDate,
  endDate
} = require('./config');
const { async } = require('./helpers');

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
  const getDividendsJSON = (csvFilePath) => {
    //const csvFilePath = "/Users/jesusmunoz/Desktop/workspace/jesus/node-alerts/src/aeat-calculator/div.csv";
    let csvToJson = require('convert-csv-to-json');
    let jsonArray = csvToJson
      .fieldDelimiter(',')
      .getJsonFromCsv(csvFilePath);

    jsonArray.forEach(x => {
      x.Type = x.Currency == "USD" ? "DIV_USD" : "DIV_EUR";
      x.Name = x.Symbol;
      x.Date = x.ReportDate;
      x.Hour = "00:00:00";
      x.Shares = 1;
      x.Mult = 1;
      x.Price = x.Gross;
      x.Fee = x.Withhold;
    });

    return jsonArray;
  }
  const getEURUDChangeByDate = (x, ctx) => {
    if (x.Currency == "EUR")
      return 1;
    if (ctx.EURUSDResultmap[x.Date] == undefined) {
      if (x.Date == "20200501") {
        return ctx.EURUSDResultmap["20200430"];
      }
      if (x.Date == "20210405") {
        return ctx.EURUSDResultmap["20210401"];
      }
      helpers.error("[ERROR] " + ctx.EURUSDResultmap[x.Date] + ": EURUSDResultmap for " + x.Date + " while processing " + x.Type + "/" + x.Name);
    }
    return ctx.EURUSDResultmap[x.Date];
  }
  const addDividend = (x, ctx) => {
    helpers.currency("[" + x.Date + "] [Dividendo] Nuevo apunte " + x.Type + "/" + x.Name + ": " + x.Price + " bruto " + x.Withhold + " tax = " + (+x.Price + +x.Withhold));
    //let dividendResult = { ingresoIntegro: 0, retenciones: 0, gastos: 0, extranjero: 0, impuestoExtranjero: 0 };
    // Suma de todos los dividendos recibidos. Extranjeros y Españoles. En euros y cantidad bruta
    if (x.Date < ctx.startDate || x.Date > ctx.endDate) {
      helpers.currency("  --> Movimiento no incluido en el resultado final");
      return;
    }
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
    if (ctx.currencyFIFO.length == 0 || amount == 0) return;
    const fifoAmount = ctx.currencyFIFO[0];
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
  const addStockFIFO = (x, ctx) => {
    ctx.stockFIFO.push(x);
    helpers.stock("[" + x.Date + "] [" + (x.Type == "OPT_TRD" ? "Opciones" : "Acciones") + "] Nuevo apunte " + x.Type + "/" + x.Name + ": " + x.Shares + "x" + Math.abs(x.Price * x.Mult) + " = " + Math.abs(x.Price * x.Shares * x.Mult) + " @ " + getEURUDChangeByDate(x, ctx));
    return;
  }
  const removeStockFIFO = (x, ctx, includeCurrency) => {
    const idx = ctx.stockFIFO.findIndex(y => x.Name == y.Name);
    if (idx == -1) {
      helpers.error("Movement unmatched: [" + x.Date + "] " + x.Name);
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
  const createContext = async () => {
    let currencyFIFO = [];
    let stockFIFO = [];
    let stockResult = { buyPriceEUR: 0, buyFeeEUR: 0, sellPriceEUR: 0, sellFeeEUR: 0 };
    let optionResult = { buyPriceEUR: 0, buyFeeEUR: 0, sellPriceEUR: 0, sellFeeEUR: 0 };
    let currencyResult = { buyPriceEUR: 0, buyFeeEUR: 0, sellPriceEUR: 0, sellFeeEUR: 0 };
    let dividendResult = { ingresoIntegro: 0, retenciones: 0, gastos: 10, extranjero: 0, impuestoExtranjero: 0 };
    const EURUSDResultmap = await getEURExchangeRates();
    return { EURUSDResultmap, currencyFIFO, stockFIFO, stockResult, optionResult, currencyResult, dividendResult, startDate, endDate };
  }
  const importSources = () => {
    let movements = [];

    csvFilePathArr.forEach(x => {
      getMovementsJSON(x).forEach(x => movements.push(x));
    })
    csvFilePathDivArr.forEach(x => {
      getDividendsJSON(x).forEach(x => movements.push(x));
    })

    movements = orderMovementsJSON(movements);
    return movements;
  }
  const printCurrencyOperationResult = (x, amount, fifoAmount, msg, ctx) => {
    const buyChangeRate = fifoAmount.source.Type == "CASH_TRD" ? fifoAmount.source.Price : getEURUDChangeByDate(fifoAmount.source, ctx);
    const buyPriceEUR = Math.abs(amount) / buyChangeRate;
    const sellPriceEUR = Math.abs(amount) / getEURUDChangeByDate(x, ctx);
    helpers.currency("[" + x.Date + "] " + msg + " " + fifoAmount.source.Type + "/" + fifoAmount.source.Name + " [" + fifoAmount.source.Date + "]: " + amount + " @ " + buyChangeRate);
    if (x.Date < ctx.startDate || x.Date > ctx.endDate) {
      helpers.currency("  --> Movimiento no incluido en el resultado final");
      return;
    }
    ctx.currencyResult.buyPriceEUR += buyPriceEUR;
    ctx.currencyResult.sellPriceEUR += sellPriceEUR;
    if (fifoAmount.source.Type == "CASH_TRD" && amount >= fifoAmount.amount) {
      ctx.currencyResult.buyFeeEUR += +fifoAmount.source.Fee;
    }
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
    const movDate = Math.max(x.Date, y.Date);
    msg = msg.replace("Stock", x.Type == "OPT_TRD" ? "Opciones" : "Acciones");
    helpers.stock("[" + movDate + "] " + msg + " " + x.Type + "/" + x.Name + ": " + sharesX + "x" + Math.abs(x.Price * x.Mult) + " = " + Math.abs(x.Price * sharesX * x.Mult) + " @ " + getEURUDChangeByDate(x, ctx));
    if (movDate < ctx.startDate || movDate > ctx.endDate) {
      helpers.stock("  --> Movimiento no incluido en el resultado final");
      return;
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
    } else if (x.Type == "STK_TRD") {
      ctx.stockResult.buyPriceEUR += buyPriceEUR;
      ctx.stockResult.buyFeeEUR += buyFeeEUR;
      ctx.stockResult.sellPriceEUR += sellPriceEUR;
      ctx.stockResult.sellFeeEUR += sellFeeEUR;
    } else {
      helpers.error("[ERROR] Type=" + x.Type);
      return;
    }
    helpers.stock("  --> buyPriceEUR = " + Math.abs(x.Price * sharesX * x.Mult).toFixed(2).toString() + "/" + getEURUDChangeByDate(x, ctx) + " = " + buyPriceEUR);
    helpers.stock("  --> sellPriceEUR = " + Math.abs(y.Price * sharesY * y.Mult).toFixed(2).toString() + "/" + getEURUDChangeByDate(y, ctx) + " = " + sellPriceEUR);
    helpers.stock("  --> P/G = " + sellPriceEUR.toFixed(2).toString() + "-" + buyPriceEUR.toFixed(2).toString() + (Math.sign(sellFeeEUR) >= 0 ? "+" : "") + sellFeeEUR.toFixed(2).toString() + (Math.sign(buyFeeEUR) >= 0 ? "+" : "") + buyFeeEUR.toFixed(2).toString() + " = " + (sellPriceEUR - buyPriceEUR + sellFeeEUR + buyFeeEUR) + " EUR");
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
  const sources = importSources();
  let context = await createContext();
  sources.forEach(x => processMovement(x, context));
  helpers.notice("optionResult: " + JSON.stringify(context.optionResult));
  helpers.notice("stockResult: " + JSON.stringify(context.stockResult));
  helpers.notice("currencyResult: " + JSON.stringify(context.currencyResult));
  helpers.notice("dividendResult: " + JSON.stringify(context.dividendResult));
  helpers.notice("stockFIFO: "); context.stockFIFO.forEach(x => helpers.notice(x.Shares + " x " + x.Name));
  helpers.notice("currencyFIFO: "); context.currencyFIFO.forEach(x => helpers.notice("[" + x.source.Date + "] " + x.amount + " x " + x.source.Name + " @ " + (x.source.Type == "CASH_TRD" ? x.source.Price : getEURUDChangeByDate(x.source, context))));

  console.timeEnd(TIMER);
}

run();