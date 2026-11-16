<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rules\Password;

use function Laravel\Prompts\password;
use function Laravel\Prompts\text;

#[Signature('user:create {--admin : Crea un amministratore}')]
#[Description('Crea un utente già approvato (il primo admin si crea così)')]
class CreateUser extends Command
{
    public function handle(): int
    {
        $name = text('Nome', required: true);
        $email = text('Email', required: true, validate: fn (string $value): ?string => $this->firstError('email', $value, ['email', 'unique:users,email']));
        $password = password('Password', required: true, validate: fn (string $value): ?string => $this->firstError('password', $value, [Password::defaults()]));

        $user = new User(['name' => $name, 'email' => $email, 'password' => $password]);
        $user->forceFill(['is_admin' => (bool) $this->option('admin'), 'approved_at' => now()])->save();

        $this->components->info(sprintf('Utente %s creato%s.', $user->email, $user->is_admin ? ' come amministratore' : ''));

        return self::SUCCESS;
    }

    /**
     * @param  array<int, mixed>  $rules
     */
    private function firstError(string $field, string $value, array $rules): ?string
    {
        return Validator::make([$field => $value], [$field => $rules])->errors()->first($field) ?: null;
    }
}
