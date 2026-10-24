<?php
/**
 * qa-kit wp-site wp: WP-CLI with its arguments read from a JSON file.
 * Playground's `php` command turns numeric arguments into empty strings (`post get 54`
 * would reach WP-CLI as `post get ""`), so the arguments travel in a file instead.
 *
 * Usage (inside Playground): php wp-site-cli.php /qa-import/<args>.json
 */

$qa_kit_args = json_decode( (string) file_get_contents( $argv[1] ), true );
if ( ! is_array( $qa_kit_args ) ) {
	fwrite( STDERR, "qa-kit: the WP-CLI arguments file is not a JSON array\n" );
	exit( 1 );
}
$_SERVER['argv'] = array_merge( array( 'wp' ), array_map( 'strval', $qa_kit_args ) );
$_SERVER['argc'] = count( $_SERVER['argv'] );
$GLOBALS['argv'] = $_SERVER['argv'];
$GLOBALS['argc'] = $_SERVER['argc'];
require '/qa-tools/wp-cli.phar';
