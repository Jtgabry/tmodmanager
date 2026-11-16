<?php

namespace App\Support;

use App\Models\User;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * Configurazione iniziale: finché non esiste un amministratore, il sito mostra la pagina
 * "Crea l'amministratore" invece del login.
 *
 * Per non lasciare l'account admin al primo che apre il sito, serve un codice monouso: lo stampa
 * `php artisan setup:code` (l'installer lo mostra insieme all'indirizzo) e viene cancellato appena
 * l'amministratore è creato.
 */
class InitialSetup
{
    public static function required(): bool
    {
        return ! User::query()->where('is_admin', true)->exists();
    }

    /** Il codice attuale, generato al primo uso. */
    public static function code(): string
    {
        $path = self::path();
        if (File::exists($path) && ($code = trim(File::get($path))) !== '') {
            return $code;
        }

        $code = Str::upper(Str::random(4).'-'.Str::random(4).'-'.Str::random(4));
        File::ensureDirectoryExists(dirname($path));
        File::put($path, $code);
        @chmod($path, 0600);

        return $code;
    }

    public static function verify(?string $given): bool
    {
        if (! is_string($given) || ! File::exists(self::path())) {
            return false;
        }

        return hash_equals(Str::upper(trim(File::get(self::path()))), Str::upper(trim($given)));
    }

    public static function forget(): void
    {
        File::delete(self::path());
    }

    private static function path(): string
    {
        return storage_path('app/private/setup-code');
    }
}
