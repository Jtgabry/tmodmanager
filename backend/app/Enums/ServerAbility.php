<?php

namespace App\Enums;

/**
 * Cosa può fare un utente (non admin) su un server.
 * Avere un accesso al server implica sempre View.
 */
enum ServerAbility: string
{
    case View = 'view';
    case Console = 'console';
    case Power = 'power';
    case Mods = 'mods';
    case Files = 'files';
    case Backups = 'backups';
}
