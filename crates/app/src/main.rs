//! `stuffcloud-app`: see `stuffcloud_app::cli` for the commands.

use std::process::ExitCode;

use stuffcloud_app::cli;
use stuffcloud_app::config::ProcessEnvironment;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = cli::run(
        &args,
        &ProcessEnvironment,
        &mut std::io::stdout(),
        &mut std::io::stderr(),
    );
    ExitCode::from(code)
}
