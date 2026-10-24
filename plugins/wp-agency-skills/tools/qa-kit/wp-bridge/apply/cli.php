<?php
/**
 * Agency bridge over WP-CLI: the same engine as the apply plugin, for a
 * site we reach over SSH and for our Playground copies.
 *
 *   wp eval-file cli.php <payload.json | payload.php> check|apply|rollback
 *   wp eval-file cli.php <targets.json> read     (qa-kit bridge build: current values)
 *
 * Prints one JSON line. Exit code 1 when the action did not succeed.
 *
 * @package AgencyBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
require_once __DIR__ . '/includes/class-agency-bridge-edits.php';

$agency_bridge_args = isset( $args ) && is_array( $args ) ? $args : array();
$agency_bridge_file = (string) ( $agency_bridge_args[0] ?? '' );
$agency_bridge_do   = (string) ( $agency_bridge_args[1] ?? 'check' );

try {
	if ( 'read' === $agency_bridge_do ) {
		$agency_bridge_targets = json_decode( (string) file_get_contents( $agency_bridge_file ), true );
		if ( ! is_array( $agency_bridge_targets ) ) {
			throw new InvalidArgumentException( 'the targets file is not a JSON array' );
		}
		$agency_bridge_reader = new Agency_Bridge_Edits(
			array(
				'manifest' => array(
					'format' => Agency_Bridge_Edits::FORMAT,
					'id'     => str_repeat( '0', 16 ),
					'edits'  => array(),
				),
			)
		);
		$agency_bridge_out = array();
		foreach ( $agency_bridge_targets as $agency_bridge_target ) {
			try {
				$agency_bridge_out[] = array( 'value' => $agency_bridge_reader->read( (array) $agency_bridge_target ) );
			} catch ( Exception $e ) {
				$agency_bridge_out[] = array( 'error' => $e->getMessage() );
			}
		}
		echo wp_json_encode( array( 'ok' => true, 'values' => $agency_bridge_out ) ), "\n";
		return;
	}
	$agency_bridge_set = Agency_Bridge_Edits::load( $agency_bridge_file );
	if ( 'check' === $agency_bridge_do ) {
		$agency_bridge_result = array( 'ok' => true ) + $agency_bridge_set->check();
	} elseif ( 'apply' === $agency_bridge_do ) {
		$agency_bridge_result = $agency_bridge_set->apply( 'wp-cli' );
	} elseif ( 'rollback' === $agency_bridge_do ) {
		$agency_bridge_result = $agency_bridge_set->rollback();
	} else {
		throw new InvalidArgumentException( 'the action is check, apply, rollback or read' );
	}
} catch ( Exception $e ) {
	$agency_bridge_result = array(
		'ok'      => false,
		'status'  => 'error',
		'message' => $e->getMessage(),
	);
}
echo wp_json_encode( $agency_bridge_result, JSON_UNESCAPED_UNICODE ), "\n";
if ( empty( $agency_bridge_result['ok'] ) && class_exists( 'WP_CLI' ) ) {
	WP_CLI::halt( 1 );
}
