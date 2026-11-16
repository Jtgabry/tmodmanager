<?php

namespace App\Console\Commands;

use App\Support\InitialSetup;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

#[Signature('setup:code {--url : Stampa solo l\'indirizzo della pagina di configurazione}')]
#[Description('Mostra il codice per creare il primo amministratore dal browser')]
class SetupCode extends Command
{
    public function handle(): int
    {
        if (! InitialSetup::required()) {
            $this->components->info('Configurazione già completata: esiste un amministratore.');

            return self::SUCCESS;
        }

        $code = InitialSetup::code();
        $url = rtrim((string) config('app.url'), '/').'/setup?code='.urlencode($code);

        if ($this->option('url')) {
            $this->line($url);

            return self::SUCCESS;
        }

        $this->components->twoColumnDetail('Codice', $code);
        $this->components->twoColumnDetail('Pagina', $url);

        return self::SUCCESS;
    }
}
