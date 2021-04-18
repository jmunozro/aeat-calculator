const chalk = require('chalk');
const DEBUG = process.env.DEBUG || ""

global = {
  debug: x => {
    if (DEBUG == "1") {
      console.log(chalk.cyan(x));
    }
    return;
  },
  notice: x => console.log(chalk.italic.cyan(x)),
  ok: x => console.log(chalk.bold.green(x)),
  currency: x => console.log(chalk.bold.blue(x)),
  dividend: x => console.log(chalk.bold.magenta(x)),
  stock: x => {
    if (x.includes("Opciones")) {
      console.log(chalk.bold.green(x));
    } else if (x.includes("Acciones")){
      console.log(chalk.bold.magenta(x));
    } else {
      console.log(chalk.bold.red(x));
    }
  },
  options: x => console.log(chalk.bold.green(x)),
  warn: x => console.log(chalk.bold.italic.yellow(x)),
  error: x => console.log(chalk.bold.hex('#FFFF00').bgRed(x)),
  responseIsOk: response => response.body && response.code && response.cookies,
};

module.exports = global;