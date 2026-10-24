<?php
/**
 * Agency bridge: the edit engine.
 *
 * Checks, applies and rolls back one recorded edit set (manifest format
 * "agency-edits/1", built by `qa-kit bridge build` from a Playground copy of the
 * client's site) on a live WordPress site. Used by the apply plugin's admin page and
 * by WP-CLI over SSH (cli.php). No remote calls, no eval, no SQL built from input
 * except through $wpdb->update / prepare.
 *
 * Rules:
 * - Preflight first: every edit's target must still hold the "before" value we copied
 *   (or already the "after" value = done). Any other value is a conflict: nothing is
 *   written at all and the conflicting items are reported.
 * - Every touched value / file is backed up before the first write; "rollback"
 *   restores the backups exactly, but only where the site still holds our "after".
 * - The same set never applies twice (state per set id in the option below).
 *
 * @package AgencyBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'Agency_Bridge_Edits' ) ) :

	/**
	 * One edit set: check / apply / rollback.
	 */
	class Agency_Bridge_Edits {

		const FORMAT       = 'agency-edits/1';
		const STATE_OPTION = 'agency_bridge_apply_state';
		const DIR_OPTION   = 'agency_bridge_apply_dir';

		const POST_FIELDS = array( 'post_title', 'post_content', 'post_excerpt', 'post_name', 'post_status', 'menu_order', 'post_parent', 'comment_status', 'ping_status' );
		const TERM_FIELDS = array( 'name', 'slug', 'description', 'parent' );

		// Options an edit set may never change: the address, users and roles, plugins and
		// the theme, WordPress internals and our own state.
		const BLOCKED_OPTIONS = '/^(siteurl|home|active_plugins|active_sitewide_plugins|template|stylesheet|admin_email|new_admin_email|users_can_register|default_role|[a-z0-9_]*user_roles|cron|rewrite_rules|db_version|initial_db_version|auth_key|auth_salt|logged_in_key|logged_in_salt|nonce_key|nonce_salt|secret_key|recovery_keys|agency_bridge_\w*)$/';

		// Files a set may write inside the active theme.
		const FILE_PATH = '/^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/';
		const FILE_EXT  = '/\.(php|css|js|mjs|json|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|eot|txt|html?|xml|pot?|mo|twig|scss|map|md)$/i';

		/** @var array */
		private $manifest;
		/** @var array path => binary content */
		private $files = array();
		/** @var string */
		private $id;
		/** @var string[] other forms of the live address (http/https, www) -> $home */
		private $aliases = array();
		/** @var string */
		private $home = '';

		/**
		 * @param array $payload { manifest: array, files: { path: base64 } }.
		 * @throws InvalidArgumentException When the payload is not an edit set.
		 */
		public function __construct( array $payload ) {
			$manifest = isset( $payload['manifest'] ) && is_array( $payload['manifest'] ) ? $payload['manifest'] : null;
			if ( ! $manifest || ( $manifest['format'] ?? '' ) !== self::FORMAT || ! isset( $manifest['edits'] ) || ! is_array( $manifest['edits'] ) ) {
				throw new InvalidArgumentException( 'not an agency-edits/1 edit set' );
			}
			foreach ( (array) ( $payload['files'] ?? array() ) as $key => $b64 ) {
				$bytes = base64_decode( (string) $b64, true );
				if ( false === $bytes ) {
					throw new InvalidArgumentException( 'a file of the set is not base64: ' . $key );
				}
				$this->files[ (string) $key ] = $bytes;
			}
			$this->manifest = $manifest;
			$this->id       = (string) ( $manifest['id'] ?? '' );
			$this->home     = (string) ( $manifest['site']['home'] ?? '' );
			foreach ( (array) ( $manifest['site']['aliases'] ?? array() ) as $alias ) {
				if ( is_string( $alias ) && '' !== $alias && $alias !== $this->home ) {
					$this->aliases[] = $alias;
					$this->aliases[] = str_replace( '/', '\/', $alias );
				}
			}
			if ( ! preg_match( '/^[a-f0-9]{16,64}$/', $this->id ) ) {
				throw new InvalidArgumentException( 'the edit set has no id' );
			}
		}

		/** Reads a payload file: JSON, or the plugin's payload.php (returns base64 JSON). */
		public static function load( $file ) {
			if ( ! is_readable( $file ) ) {
				throw new InvalidArgumentException( 'cannot read ' . $file );
			}
			if ( '.php' === substr( $file, -4 ) ) {
				$raw = base64_decode( (string) include $file, true );
			} else {
				$raw = file_get_contents( $file );
			}
			$payload = json_decode( (string) $raw, true );
			if ( ! is_array( $payload ) ) {
				throw new InvalidArgumentException( 'the edit set is not JSON' );
			}
			return new self( $payload );
		}

		public function id() {
			return $this->id;
		}

		public function manifest() {
			return $this->manifest;
		}

		/** This set's saved state: null, or { status, applied_at, rolled_back_at, user, items }. */
		public function state() {
			$all = get_option( self::STATE_OPTION, array() );
			return is_array( $all ) && isset( $all[ $this->id ] ) ? $all[ $this->id ] : null;
		}

		private function save_state( $state ) {
			$all = get_option( self::STATE_OPTION, array() );
			$all = is_array( $all ) ? $all : array();
			$all[ $this->id ] = $state;
			// Not autoloaded: it can hold backups.
			if ( false === get_option( self::STATE_OPTION, false ) ) {
				add_option( self::STATE_OPTION, $all, '', 'no' );
			} else {
				update_option( self::STATE_OPTION, $all, false );
			}
		}

		/**
		 * Preflight without writing: { status: ready|applied|done|conflict|invalid, items: [...] }.
		 * Item states: ready (holds "before"), done (holds "after"), conflict, invalid.
		 */
		public function check() {
			$state = $this->state();
			$items = array();
			$theme = (string) ( $this->manifest['theme'] ?? '' );
			foreach ( $this->manifest['edits'] as $i => $edit ) {
				$items[] = $this->check_item( (array) $edit, $i, $theme );
			}
			$counts = array_count_values( array_column( $items, 'state' ) );
			if ( ! empty( $counts['invalid'] ) ) {
				$status = 'invalid';
			} elseif ( ! empty( $counts['conflict'] ) ) {
				$status = 'conflict';
			} elseif ( $state && 'applied' === $state['status'] ) {
				$status = 'applied';
			} elseif ( empty( $counts['ready'] ) ) {
				$status = 'done';
			} else {
				$status = 'ready';
			}
			return array(
				'id'     => $this->id,
				'order'  => (string) ( $this->manifest['order'] ?? '' ),
				'status' => $status,
				'saved'  => $state ? $state['status'] : null,
				'counts' => $counts,
				'items'  => $items,
			);
		}

		private function check_item( array $edit, $i, $theme ) {
			$item = array(
				'n'     => $i + 1,
				'type'  => (string) ( $edit['type'] ?? '' ),
				'label' => (string) ( $edit['label'] ?? '' ),
			);
			$problem = $this->invalid( $edit, $theme );
			if ( $problem ) {
				return $item + array( 'state' => 'invalid', 'message' => $problem );
			}
			try {
				$now = $this->read( $edit );
			} catch ( Exception $e ) {
				return $item + array( 'state' => 'invalid', 'message' => $e->getMessage() );
			}
			$before = 'theme_file' === $edit['type'] ? ( $edit['before_sha256'] ?? null ) : ( $edit['before'] ?? null );
			$after  = 'theme_file' === $edit['type'] ? ( $edit['after_sha256'] ?? null ) : ( $edit['after'] ?? null );
			if ( $this->eq( $now, $after ) ) {
				return $item + array( 'state' => 'done' );
			}
			if ( $this->eq( $now, $before ) ) {
				return $item + array( 'state' => 'ready' );
			}
			return $item + array(
				'state'    => 'conflict',
				'message'  => 'на сайті зараз інше значення, ніж у копії, з якої робили правку',
				'expected' => self::preview( $before ),
				'current'  => self::preview( $now ),
			);
		}

		/** Why an edit cannot run at all (null = fine). */
		private function invalid( array $edit, $theme ) {
			$type = $edit['type'] ?? '';
			switch ( $type ) {
				case 'option':
					$name = (string) ( $edit['name'] ?? '' );
					if ( '' === $name || preg_match( self::BLOCKED_OPTIONS, $name ) ) {
						return 'цю опцію змінювати не можна: ' . $name;
					}
					return null;
				case 'post_field':
					if ( ! in_array( $edit['field'] ?? '', self::POST_FIELDS, true ) ) {
						return 'непідтримуване поле запису';
					}
					return get_post( (int) ( $edit['post'] ?? 0 ) ) ? null : 'запису ' . (int) ( $edit['post'] ?? 0 ) . ' на сайті немає';
				case 'post_meta':
				case 'elementor':
					if ( 'post_meta' === $type && '' === (string) ( $edit['key'] ?? '' ) ) {
						return 'немає ключа поля';
					}
					if ( 'elementor' === $type && ( '' === (string) ( $edit['element'] ?? '' ) || '' === (string) ( $edit['setting'] ?? '' ) ) ) {
						return 'немає елемента або налаштування Elementor';
					}
					return get_post( (int) ( $edit['post'] ?? 0 ) ) ? null : 'запису ' . (int) ( $edit['post'] ?? 0 ) . ' на сайті немає';
				case 'term_field':
					if ( ! in_array( $edit['field'] ?? '', self::TERM_FIELDS, true ) ) {
						return 'непідтримуване поле терміна';
					}
					// Fall through: the term must exist.
				case 'term_meta':
					if ( 'term_meta' === $type && '' === (string) ( $edit['key'] ?? '' ) ) {
						return 'немає ключа поля';
					}
					$term = get_term( (int) ( $edit['term'] ?? 0 ) );
					return ( $term && ! is_wp_error( $term ) ) ? null : 'терміна ' . (int) ( $edit['term'] ?? 0 ) . ' на сайті немає';
				case 'theme_file':
					if ( '' === $theme || get_stylesheet() !== $theme ) {
						return 'активна тема сайту «' . get_stylesheet() . '», а правки зроблені для «' . $theme . '»';
					}
					$path = (string) ( $edit['path'] ?? '' );
					if ( ! self::safe_path( $path ) ) {
						return 'недозволений шлях файлу: ' . $path;
					}
					$after = $edit['after_sha256'] ?? null;
					if ( null !== $after ) {
						$bytes = $this->files[ $path ] ?? null;
						if ( null === $bytes || hash( 'sha256', $bytes ) !== $after ) {
							return 'файлу ' . $path . ' немає в наборі правок або він пошкоджений';
						}
					}
					$target = $this->theme_target( $path );
					$dir    = $this->writable_parent( dirname( $target ) );
					if ( ! $dir || ! wp_is_writable( $dir ) || ( file_exists( $target ) && ! wp_is_writable( $target ) ) ) {
						return 'немає права запису у файл теми ' . $path;
					}
					return null;
				default:
					return 'невідомий тип правки: ' . $type;
			}
		}

		/** The current value of an edit's target (the same reader built the set in the copy). */
		public function read( array $edit ) {
			global $wpdb;
			switch ( $edit['type'] ?? '' ) {
				case 'option':
					$missing = new stdClass();
					$value   = get_option( (string) $edit['name'], $missing );
					return $value === $missing ? null : $value;
				case 'post_field':
					if ( ! in_array( $edit['field'] ?? '', self::POST_FIELDS, true ) ) {
						throw new RuntimeException( 'непідтримуване поле запису' );
					}
					$value = $wpdb->get_var( $wpdb->prepare( "SELECT `{$edit['field']}` FROM {$wpdb->posts} WHERE ID = %d", (int) $edit['post'] ) );
					return null === $value ? null : (string) $value;
				case 'post_meta':
					return self::single_meta( 'post', (int) $edit['post'], (string) $edit['key'] );
				case 'term_field':
					if ( ! in_array( $edit['field'] ?? '', self::TERM_FIELDS, true ) ) {
						throw new RuntimeException( 'непідтримуване поле терміна' );
					}
					$col   = in_array( $edit['field'], array( 'name', 'slug' ), true ) ? 't.`' . $edit['field'] . '`' : 'tt.`' . $edit['field'] . '`';
					$value = $wpdb->get_var( $wpdb->prepare( "SELECT {$col} FROM {$wpdb->terms} t JOIN {$wpdb->term_taxonomy} tt ON tt.term_id = t.term_id WHERE t.term_id = %d LIMIT 1", (int) $edit['term'] ) );
					return null === $value ? null : (string) $value;
				case 'term_meta':
					return self::single_meta( 'term', (int) $edit['term'], (string) $edit['key'] );
				case 'elementor':
					$data    = self::elementor_data( (int) $edit['post'] );
					$element = self::find_element( $data, (string) $edit['element'] );
					if ( null === $element ) {
						throw new RuntimeException( 'на сторінці ' . (int) $edit['post'] . ' немає елемента Elementor ' . $edit['element'] );
					}
					return $element['settings'][ $edit['setting'] ] ?? null;
				case 'theme_file':
					$target = $this->theme_target( (string) $edit['path'] );
					return is_file( $target ) ? hash_file( 'sha256', $target ) : null;
			}
			throw new RuntimeException( 'невідомий тип правки' );
		}

		private static function single_meta( $kind, $id, $key ) {
			if ( ! metadata_exists( $kind, $id, $key ) ) {
				return null;
			}
			$values = get_metadata( $kind, $id, $key, false );
			if ( count( $values ) > 1 ) {
				throw new RuntimeException( 'поле ' . $key . ' має кілька значень: така правка не підтримується' );
			}
			return $values ? $values[0] : null;
		}

		/**
		 * Applies the set: preflight, backups of every target, writes, cache flush.
		 * Returns { ok, status, message, check }.
		 */
		public function apply( $user = '' ) {
			$state = $this->state();
			if ( $state && 'applied' === $state['status'] ) {
				return array( 'ok' => true, 'status' => 'already', 'message' => 'ці правки вже застосовані' );
			}
			$check = $this->check();
			if ( in_array( $check['status'], array( 'conflict', 'invalid' ), true ) ) {
				return array( 'ok' => false, 'status' => $check['status'], 'message' => 'нічого не змінено: є конфлікти або помилки', 'check' => $check );
			}

			// Backups first, saved before the first write.
			$backup = array();
			foreach ( $this->manifest['edits'] as $i => $edit ) {
				if ( 'ready' === $check['items'][ $i ]['state'] ) {
					$backup[ $i ] = $this->backup( (array) $edit );
				}
			}
			$state = array(
				'status'     => 'applying',
				'order'      => (string) ( $this->manifest['order'] ?? '' ),
				'applied_at' => gmdate( 'c' ),
				'user'       => (string) $user,
				'backup'     => $backup,
			);
			$this->save_state( $state );

			$done = array();
			try {
				foreach ( $backup as $i => $unused ) {
					$this->write( (array) $this->manifest['edits'][ $i ], 'after' );
					$done[] = $i;
				}
			} catch ( Exception $e ) {
				// Put back what was written, newest first.
				foreach ( array_reverse( $done ) as $i ) {
					$this->restore( (array) $this->manifest['edits'][ $i ], $backup[ $i ] );
				}
				$state['status'] = 'failed';
				$state['error']  = $e->getMessage();
				$this->save_state( $state );
				$this->flush();
				return array( 'ok' => false, 'status' => 'failed', 'message' => 'помилка, усе повернуто як було: ' . $e->getMessage() );
			}
			$state['status'] = 'applied';
			$this->save_state( $state );
			$this->flush();
			return array( 'ok' => true, 'status' => 'applied', 'message' => 'застосовано правок: ' . count( $done ), 'check' => $this->check() );
		}

		/** Restores the backups where the site still holds our "after" value. */
		public function rollback() {
			$state = $this->state();
			if ( ! $state || 'applied' !== $state['status'] ) {
				return array( 'ok' => false, 'status' => 'not_applied', 'message' => 'ці правки не застосовані: відкочувати нічого' );
			}
			$conflicts = array();
			foreach ( $state['backup'] as $i => $saved ) {
				$edit  = (array) $this->manifest['edits'][ $i ];
				$after = 'theme_file' === $edit['type'] ? ( $edit['after_sha256'] ?? null ) : ( $edit['after'] ?? null );
				try {
					$now = $this->read( $edit );
				} catch ( Exception $e ) {
					$now = new stdClass();
				}
				if ( ! $this->eq( $now, $after ) ) {
					$conflicts[] = array(
						'n'       => $i + 1,
						'label'   => (string) ( $edit['label'] ?? '' ),
						'message' => 'після правок це значення змінили ще раз',
						'current' => self::preview( $now ),
					);
				}
			}
			if ( $conflicts ) {
				return array( 'ok' => false, 'status' => 'conflict', 'message' => 'нічого не відкочено: частину значень змінили після правок', 'conflicts' => $conflicts );
			}
			foreach ( array_reverse( array_keys( $state['backup'] ) ) as $i ) {
				$this->restore( (array) $this->manifest['edits'][ $i ], $state['backup'][ $i ] );
			}
			$state['status']         = 'rolled_back';
			$state['rolled_back_at'] = gmdate( 'c' );
			$this->save_state( $state );
			$this->flush();
			return array( 'ok' => true, 'status' => 'rolled_back', 'message' => 'відкочено правок: ' . count( $state['backup'] ) );
		}

		private function backup( array $edit ) {
			switch ( $edit['type'] ) {
				case 'elementor':
					// The whole page data: restored exactly.
					return array( 'raw' => get_post_meta( (int) $edit['post'], '_elementor_data', true ) );
				case 'theme_file':
					$target = $this->theme_target( (string) $edit['path'] );
					if ( ! is_file( $target ) ) {
						// A new file: rollback also removes the folders made for it.
						return array(
							'file' => null,
							'base' => $this->writable_parent( dirname( $target ) ),
						);
					}
					$dir = $this->private_dir() . '/backup/' . $this->id;
					wp_mkdir_p( $dir );
					$copy = $dir . '/' . hash( 'sha256', $edit['path'] );
					if ( ! copy( $target, $copy ) ) {
						throw new RuntimeException( 'не вдалося зберегти резервну копію ' . $edit['path'] );
					}
					return array( 'file' => $copy );
				default:
					return array( 'value' => $this->read( $edit ) );
			}
		}

		private function restore( array $edit, array $saved ) {
			if ( 'elementor' === $edit['type'] ) {
				update_post_meta( (int) $edit['post'], '_elementor_data', wp_slash( $saved['raw'] ) );
				return;
			}
			if ( 'theme_file' === $edit['type'] ) {
				$target = $this->theme_target( (string) $edit['path'] );
				if ( null === $saved['file'] ) {
					if ( is_file( $target ) ) {
						unlink( $target );
					}
					$base = isset( $saved['base'] ) ? wp_normalize_path( (string) $saved['base'] ) : '';
					$dir  = wp_normalize_path( dirname( $target ) );
					while ( '' !== $base && $dir !== $base && 0 === strpos( $dir, $base . '/' ) && is_dir( $dir ) && 2 === count( (array) scandir( $dir ) ) ) {
						rmdir( $dir );
						$dir = dirname( $dir );
					}
					return;
				}
				if ( ! copy( $saved['file'], $target ) ) {
					throw new RuntimeException( 'не вдалося повернути файл ' . $edit['path'] );
				}
				return;
			}
			$this->write( $edit, 'value', $saved['value'] );
		}

		/** Writes $edit[$which] (or $value when $which is "value"). */
		private function write( array $edit, $which, $value = null ) {
			global $wpdb;
			if ( 'value' !== $which ) {
				$value = $edit[ $which ] ?? null;
			}
			switch ( $edit['type'] ) {
				case 'option':
					if ( null === $value ) {
						delete_option( (string) $edit['name'] );
					} elseif ( ! update_option( (string) $edit['name'], $value ) && ! self::same( get_option( (string) $edit['name'] ), $value ) ) {
						throw new RuntimeException( 'опція ' . $edit['name'] . ' не записалась' );
					}
					return;
				case 'post_field':
					// Raw: no kses, no slug rewriting - exactly what was tested in the copy.
					if ( false === $wpdb->update( $wpdb->posts, array( $edit['field'] => (string) $value ), array( 'ID' => (int) $edit['post'] ) ) ) {
						throw new RuntimeException( 'запис ' . (int) $edit['post'] . ' не оновився: ' . $wpdb->last_error );
					}
					clean_post_cache( (int) $edit['post'] );
					return;
				case 'post_meta':
				case 'term_meta':
					$kind = 'post_meta' === $edit['type'] ? 'post' : 'term';
					$id   = (int) ( 'post' === $kind ? $edit['post'] : $edit['term'] );
					if ( null === $value ) {
						delete_metadata( $kind, $id, (string) $edit['key'] );
					} else {
						update_metadata( $kind, $id, (string) $edit['key'], wp_slash( $value ) );
						if ( ! self::same( self::single_meta( $kind, $id, (string) $edit['key'] ), $value ) ) {
							throw new RuntimeException( 'поле ' . $edit['key'] . ' не записалось' );
						}
					}
					return;
				case 'term_field':
					$table = in_array( $edit['field'], array( 'name', 'slug' ), true ) ? $wpdb->terms : $wpdb->term_taxonomy;
					if ( false === $wpdb->update( $table, array( $edit['field'] => (string) $value ), array( 'term_id' => (int) $edit['term'] ) ) ) {
						throw new RuntimeException( 'термін ' . (int) $edit['term'] . ' не оновився: ' . $wpdb->last_error );
					}
					clean_term_cache( (int) $edit['term'] );
					return;
				case 'elementor':
					$id   = (int) $edit['post'];
					$data = self::elementor_data( $id );
					if ( ! self::set_setting( $data, (string) $edit['element'], (string) $edit['setting'], $value ) ) {
						throw new RuntimeException( 'елемент Elementor ' . $edit['element'] . ' не знайдено' );
					}
					update_post_meta( $id, '_elementor_data', wp_slash( wp_json_encode( $data ) ) );
					return;
				case 'theme_file':
					$target = $this->theme_target( (string) $edit['path'] );
					if ( null === ( $edit['after_sha256'] ?? null ) ) {
						if ( is_file( $target ) && ! unlink( $target ) ) {
							throw new RuntimeException( 'файл ' . $edit['path'] . ' не видалився' );
						}
						return;
					}
					wp_mkdir_p( dirname( $target ) );
					if ( false === file_put_contents( $target, $this->files[ $edit['path'] ] ) ) {
						throw new RuntimeException( 'файл ' . $edit['path'] . ' не записався' );
					}
					if ( function_exists( 'opcache_invalidate' ) ) {
						opcache_invalidate( $target, true );
					}
					return;
			}
		}

		/** Caches after a change: object cache, Elementor CSS, permalinks, page-cache plugins. */
		private function flush() {
			wp_cache_flush();
			$types = array_column( $this->manifest['edits'], 'type' );
			$slugs = false;
			foreach ( $this->manifest['edits'] as $edit ) {
				if ( in_array( $edit['field'] ?? '', array( 'post_name', 'slug', 'post_parent', 'parent' ), true ) || 'permalink_structure' === ( $edit['name'] ?? '' ) ) {
					$slugs = true;
				}
			}
			if ( $slugs ) {
				flush_rewrite_rules( false );
			}
			if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
				\Elementor\Plugin::$instance->files_manager->clear_cache();
			} elseif ( in_array( 'elementor', $types, true ) ) {
				// Elementor inactive: drop the cached CSS of the edited pages at least.
				foreach ( $this->manifest['edits'] as $edit ) {
					if ( 'elementor' === $edit['type'] ) {
						delete_post_meta( (int) $edit['post'], '_elementor_css' );
					}
				}
			}
			// Common page caches (each only if that plugin is there).
			do_action( 'litespeed_purge_all' );
			if ( function_exists( 'wp_cache_clear_cache' ) ) {
				wp_cache_clear_cache();
			}
			if ( function_exists( 'w3tc_flush_all' ) ) {
				w3tc_flush_all();
			}
			if ( function_exists( 'rocket_clean_domain' ) ) {
				rocket_clean_domain();
			}
			do_action( 'wpfc_clear_all_cache' );
			do_action( 'sg_cachepress_purge_cache' );
		}

		private static function elementor_data( $post ) {
			$raw  = get_post_meta( $post, '_elementor_data', true );
			$data = is_array( $raw ) ? $raw : json_decode( (string) $raw, true );
			if ( ! is_array( $data ) ) {
				throw new RuntimeException( 'на сторінці ' . $post . ' немає даних Elementor' );
			}
			return $data;
		}

		private static function find_element( array $elements, $id ) {
			foreach ( $elements as $el ) {
				if ( ( $el['id'] ?? '' ) === $id ) {
					return $el;
				}
				if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) {
					$found = self::find_element( $el['elements'], $id );
					if ( null !== $found ) {
						return $found;
					}
				}
			}
			return null;
		}

		private static function set_setting( array &$elements, $id, $setting, $value ) {
			foreach ( $elements as &$el ) {
				if ( ( $el['id'] ?? '' ) === $id ) {
					if ( ! isset( $el['settings'] ) || ! is_array( $el['settings'] ) ) {
						$el['settings'] = array();
					}
					if ( null === $value ) {
						unset( $el['settings'][ $setting ] );
					} else {
						$el['settings'][ $setting ] = $value;
					}
					return true;
				}
				if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) && self::set_setting( $el['elements'], $id, $setting, $value ) ) {
					return true;
				}
			}
			return false;
		}

		/** A safe relative path inside a theme: no "..", no dot files, known extensions. */
		public static function safe_path( $path ) {
			return is_string( $path ) && strlen( $path ) < 300 && preg_match( self::FILE_PATH, $path ) && preg_match( self::FILE_EXT, $path )
				&& false === strpos( $path, '..' );
		}

		private function theme_target( $path ) {
			if ( ! self::safe_path( $path ) ) {
				throw new RuntimeException( 'недозволений шлях файлу: ' . $path );
			}
			$root = wp_normalize_path( get_stylesheet_directory() );
			$real = realpath( $root );
			if ( ! $real ) {
				throw new RuntimeException( 'немає папки теми' );
			}
			$target = wp_normalize_path( $real ) . '/' . $path;
			// A symlinked folder inside the theme must not lead outside it.
			$parent = $this->writable_parent( dirname( $target ) );
			if ( $parent && 0 !== strpos( wp_normalize_path( (string) realpath( $parent ) ) . '/', wp_normalize_path( $real ) . '/' ) ) {
				throw new RuntimeException( 'шлях виходить за межі теми: ' . $path );
			}
			return $target;
		}

		/** The nearest existing folder of a path (new files may need new folders). */
		private function writable_parent( $dir ) {
			while ( $dir && ! is_dir( $dir ) ) {
				$up = dirname( $dir );
				if ( $up === $dir ) {
					return null;
				}
				$dir = $up;
			}
			return $dir;
		}

		/** A private folder in uploads for file backups (random name, closed to the web). */
		private function private_dir() {
			$name = get_option( self::DIR_OPTION );
			if ( ! is_string( $name ) || ! preg_match( '/^agency-bridge-[a-f0-9]{32}$/', $name ) ) {
				$name = 'agency-bridge-' . bin2hex( random_bytes( 16 ) );
				update_option( self::DIR_OPTION, $name, false );
			}
			$uploads = wp_upload_dir( null, false );
			$dir     = $uploads['basedir'] . '/' . $name;
			if ( ! is_dir( $dir ) ) {
				wp_mkdir_p( $dir );
			}
			self::close_dir( $dir );
			return $dir;
		}

		/** Deny web access to a folder (Apache 2.2/2.4, IIS) and hide its listing. */
		public static function close_dir( $dir ) {
			$files = array(
				'.htaccess'  => "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n",
				'index.php'  => "<?php\n// Silence is golden.\n",
				'index.html' => '',
				'web.config' => "<?xml version=\"1.0\"?>\n<configuration><system.webServer><authorization><deny users=\"*\" /></authorization></system.webServer></configuration>\n",
			);
			foreach ( $files as $name => $body ) {
				if ( ! file_exists( $dir . '/' . $name ) ) {
					file_put_contents( $dir . '/' . $name, $body );
				}
			}
		}

		/** Removes the backups and state of every set (the plugin's "delete" button). */
		public static function forget_all() {
			$name = get_option( self::DIR_OPTION );
			if ( is_string( $name ) && preg_match( '/^agency-bridge-[a-f0-9]{32}$/', $name ) ) {
				$uploads = wp_upload_dir( null, false );
				self::remove_tree( $uploads['basedir'] . '/' . $name );
			}
			delete_option( self::DIR_OPTION );
			delete_option( self::STATE_OPTION );
		}

		public static function remove_tree( $dir ) {
			if ( ! is_dir( $dir ) ) {
				return;
			}
			$items = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST );
			foreach ( $items as $item ) {
				$item->isDir() && ! $item->isLink() ? rmdir( $item->getPathname() ) : unlink( $item->getPathname() );
			}
			rmdir( $dir );
		}

		/**
		 * Equal values on this site: the live address may be stored in several forms (http
		 * and https, with and without www) - all of them count as the site's home address.
		 */
		private function eq( $a, $b ) {
			return self::same( $this->home_form( $a ), $this->home_form( $b ) );
		}

		private function home_form( $v ) {
			if ( ! $this->aliases || '' === $this->home ) {
				return $v;
			}
			if ( is_string( $v ) ) {
				$escaped = str_replace( '/', '\/', $this->home );
				$to      = array();
				foreach ( $this->aliases as $i => $alias ) {
					$to[] = 0 === $i % 2 ? $this->home : $escaped;
				}
				return str_replace( $this->aliases, $to, $v );
			}
			if ( is_array( $v ) ) {
				return array_map(
					function ( $x ) {
						return $this->home_form( $x );
					},
					$v
				);
			}
			return $v;
		}

		/** Equal values: scalars compared as strings, arrays key by key (JSON-like data). */
		public static function same( $a, $b ) {
			return self::norm( $a ) === self::norm( $b );
		}

		private static function norm( $v ) {
			if ( null === $v ) {
				return null;
			}
			if ( is_bool( $v ) ) {
				return $v ? '1' : '';
			}
			if ( is_scalar( $v ) ) {
				return (string) $v;
			}
			if ( is_array( $v ) ) {
				$out = array();
				foreach ( $v as $k => $x ) {
					$out[ (string) $k ] = self::norm( $x );
				}
				return $out;
			}
			// Objects (stdClass from JSON, or a marker): compared by their JSON.
			return 'object:' . wp_json_encode( $v );
		}

		/** A short readable form of a value for the report. */
		public static function preview( $v ) {
			if ( null === $v ) {
				return '(немає)';
			}
			$s = is_scalar( $v ) ? (string) $v : wp_json_encode( $v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
			return function_exists( 'mb_substr' ) && mb_strlen( $s ) > 160 ? mb_substr( $s, 0, 160 ) . '…' : ( strlen( $s ) > 160 ? substr( $s, 0, 160 ) . '…' : $s );
		}
	}

endif;
