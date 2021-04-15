const chalk = require('chalk');
const DEBUG = process.env.DEBUG || ""

global = {
  debug: x => {
    if(DEBUG == "1"){
      console.log(chalk.cyan(x));
    }
    return;
  },
  notice: x => console.log(chalk.bold.blue(x)),
  ok: x => console.log(chalk.bold.green(x)),
  currency: x => console.log(chalk.bold.cyan(x)),
  stock: x => console.log(chalk.bold.green(x)),
  warn: x => console.log(chalk.bold.italic.yellow(x)),
  error: x => console.log(chalk.bold.yellow.bgRed(x)),
  responseIsOk: response => response.body && response.code && response.cookies,
};

module.exports = global;