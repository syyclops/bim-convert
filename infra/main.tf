terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

data "azurerm_subscription" "current" {}

locals {
  queue_name = "conversions"
}

# --- Resource Group ---

resource "azurerm_resource_group" "main" {
  name     = "${var.resource_prefix}-rg"
  location = var.location
}

# --- Storage Account ---

resource "azurerm_storage_account" "main" {
  name                     = "${var.resource_prefix}stor"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

# Blob containers
resource "azurerm_storage_container" "deploy" {
  name                  = "deploy"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_container" "inputs" {
  name                  = "inputs"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_container" "outputs" {
  name                  = "outputs"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_container" "jobs" {
  name                  = "jobs"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

resource "azurerm_storage_container" "logs" {
  name                  = "logs"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

# Storage queue
resource "azurerm_storage_queue" "conversions" {
  name                 = local.queue_name
  storage_account_name = azurerm_storage_account.main.name
}

# Blob lifecycle rules
resource "azurerm_storage_management_policy" "lifecycle" {
  storage_account_id = azurerm_storage_account.main.id

  rule {
    name    = "delete-inputs-1d"
    enabled = true
    filters {
      prefix_match = ["inputs/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 1
      }
    }
  }

  rule {
    name    = "delete-outputs-7d"
    enabled = true
    filters {
      prefix_match = ["outputs/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 7
      }
    }
  }

  rule {
    name    = "delete-logs-7d"
    enabled = true
    filters {
      prefix_match = ["logs/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 7
      }
    }
  }

  rule {
    name    = "delete-jobs-30d"
    enabled = true
    filters {
      prefix_match = ["jobs/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 30
      }
    }
  }
}

# --- Deploy Artifacts ---

# Zip app files for deployment — runs every apply
resource "null_resource" "zip_app" {
  provisioner "local-exec" {
    command = "cd ${path.module}/.. && rm -f app.zip && zip -r -q app.zip server.ts worker.ts index.html package.json tsconfig.json bun.lock lib/"
  }
  triggers = {
    always_run = timestamp()
  }
}

resource "azurerm_storage_blob" "app_zip" {
  name                   = "app.zip"
  storage_account_name   = azurerm_storage_account.main.name
  storage_container_name = azurerm_storage_container.deploy.name
  type                   = "Block"
  source                 = "${path.module}/../app.zip"
  depends_on             = [null_resource.zip_app]

  lifecycle {
    replace_triggered_by = [null_resource.zip_app.id]
  }
}

# Zip and upload datadrivenlibs
resource "null_resource" "zip_datadrivenlibs" {
  provisioner "local-exec" {
    command = "cd ${path.module}/.. && zip -r -q datadrivenlibs.zip datadrivenlibs/"
  }
  triggers = {
    always_run = timestamp()
  }
}

resource "azurerm_storage_blob" "datadrivenlibs_zip" {
  name                   = "datadrivenlibs.zip"
  storage_account_name   = azurerm_storage_account.main.name
  storage_container_name = azurerm_storage_container.deploy.name
  type                   = "Block"
  source                 = "${path.module}/../datadrivenlibs.zip"
  depends_on             = [null_resource.zip_datadrivenlibs]
}

# Bootstrap scripts
resource "azurerm_storage_blob" "api_bootstrap" {
  name                   = "api-bootstrap.sh"
  storage_account_name   = azurerm_storage_account.main.name
  storage_container_name = azurerm_storage_container.deploy.name
  type                   = "Block"
  source                 = "${path.module}/api-bootstrap.sh"
  content_md5            = filemd5("${path.module}/api-bootstrap.sh")
}

resource "azurerm_storage_blob" "worker_bootstrap" {
  name                   = "worker-bootstrap.ps1"
  storage_account_name   = azurerm_storage_account.main.name
  storage_container_name = azurerm_storage_container.deploy.name
  type                   = "Block"
  source                 = "${path.module}/worker-bootstrap.ps1"
  content_md5            = filemd5("${path.module}/worker-bootstrap.ps1")
}

# --- Networking ---

resource "azurerm_virtual_network" "main" {
  name                = "${var.resource_prefix}-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_subnet" "api" {
  name                 = "${var.resource_prefix}-api-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_subnet" "worker" {
  name                 = "${var.resource_prefix}-worker-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.2.0/24"]
  service_endpoints    = ["Microsoft.Storage"]
}

resource "azurerm_network_security_group" "api" {
  name                = "${var.resource_prefix}-api-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  security_rule {
    name                       = "AllowHTTPS"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "AllowHTTP"
    priority                   = 105
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "AllowSSH"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.allowed_ip
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_security_group" "worker" {
  name                = "${var.resource_prefix}-worker-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  security_rule {
    name                       = "AllowRDP"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3389"
    source_address_prefix      = var.allowed_ip
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "api" {
  subnet_id                 = azurerm_subnet.api.id
  network_security_group_id = azurerm_network_security_group.api.id
}

resource "azurerm_subnet_network_security_group_association" "worker" {
  subnet_id                 = azurerm_subnet.worker.id
  network_security_group_id = azurerm_network_security_group.worker.id
}

resource "azurerm_public_ip" "api" {
  name                = "${var.resource_prefix}-api-pip"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "api" {
  name                = "${var.resource_prefix}-api-nic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.api.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.api.id
  }
}

resource "azurerm_network_interface" "worker" {
  name                = "${var.resource_prefix}-worker-nic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.worker.id
    private_ip_address_allocation = "Dynamic"
  }
}

# --- API VM (Linux) ---

resource "azurerm_linux_virtual_machine" "api" {
  name                            = "${var.resource_prefix}-api"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  size                            = var.api_vm_size
  admin_username                  = var.admin_username
  admin_password                  = var.admin_password
  disable_password_authentication = false

  network_interface_ids = [azurerm_network_interface.api.id]

  identity {
    type = "SystemAssigned"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
    disk_size_gb         = 30
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }
}

resource "azurerm_virtual_machine_extension" "api_bootstrap" {
  name                       = "api-bootstrap"
  virtual_machine_id         = azurerm_linux_virtual_machine.api.id
  publisher                  = "Microsoft.Azure.Extensions"
  type                       = "CustomScript"
  type_handler_version       = "2.1"
  auto_upgrade_minor_version = true

  depends_on = [
    azurerm_storage_blob.app_zip,
    azurerm_storage_blob.api_bootstrap,
  ]

  settings = jsonencode({
    fileUris = [
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/api-bootstrap.sh",
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/app.zip"
    ]
    timestamp = parseint(formatdate("YYYYMMDDhhmmss", timestamp()), 10)
  })

  protected_settings = jsonencode({
    storageAccountName = azurerm_storage_account.main.name
    storageAccountKey  = azurerm_storage_account.main.primary_access_key
    commandToExecute   = "bash api-bootstrap.sh '${var.domain}' '${azurerm_storage_account.main.primary_connection_string}' '${local.queue_name}' '${azurerm_windows_virtual_machine.worker.name}' '${azurerm_resource_group.main.name}' '${data.azurerm_subscription.current.subscription_id}'"
  })
}

# --- Worker VM (Windows) ---

resource "azurerm_windows_virtual_machine" "worker" {
  name                = "${var.resource_prefix}-wkr"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  size                = var.worker_vm_size
  admin_username      = var.admin_username
  admin_password      = var.admin_password

  network_interface_ids = [azurerm_network_interface.worker.id]

  identity {
    type = "SystemAssigned"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 128
  }

  source_image_reference {
    publisher = "MicrosoftWindowsServer"
    offer     = "WindowsServer"
    sku       = "2022-datacenter-azure-edition"
    version   = "latest"
  }
}

resource "azurerm_virtual_machine_extension" "worker_bootstrap" {
  name                       = "worker-bootstrap"
  virtual_machine_id         = azurerm_windows_virtual_machine.worker.id
  publisher                  = "Microsoft.Compute"
  type                       = "CustomScriptExtension"
  type_handler_version       = "1.10"
  auto_upgrade_minor_version = true

  depends_on = [
    azurerm_storage_blob.app_zip,
    azurerm_storage_blob.worker_bootstrap,
    azurerm_storage_blob.datadrivenlibs_zip,
  ]

  settings = jsonencode({
    fileUris = [
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/worker-bootstrap.ps1",
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/app.zip",
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/datadrivenlibs.zip"
    ]
    timestamp = timestamp()
  })

  protected_settings = jsonencode({
    storageAccountName = azurerm_storage_account.main.name
    storageAccountKey  = azurerm_storage_account.main.primary_access_key
    commandToExecute   = "powershell -ExecutionPolicy Unrestricted -File worker-bootstrap.ps1 -StorageConnectionString '${azurerm_storage_account.main.primary_connection_string}' -QueueName '${local.queue_name}' -VMName '${azurerm_windows_virtual_machine.worker.name}' -ResourceGroup '${azurerm_resource_group.main.name}' -SubscriptionId '${data.azurerm_subscription.current.subscription_id}' -IdleTimeoutMinutes ${var.worker_idle_timeout_minutes}"
  })
}

# --- IAM Role Assignments ---

# API VM can start the worker VM
resource "azurerm_role_assignment" "api_vm_contributor" {
  scope                = azurerm_windows_virtual_machine.worker.id
  role_definition_name = "Virtual Machine Contributor"
  principal_id         = azurerm_linux_virtual_machine.api.identity[0].principal_id
}

# Worker VM can deallocate itself
resource "azurerm_role_assignment" "worker_vm_contributor" {
  scope                = azurerm_windows_virtual_machine.worker.id
  role_definition_name = "Virtual Machine Contributor"
  principal_id         = azurerm_windows_virtual_machine.worker.identity[0].principal_id
}

# Worker VM can access blob storage
resource "azurerm_role_assignment" "worker_storage_blob" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_windows_virtual_machine.worker.identity[0].principal_id
}

# Worker VM can access storage queues
resource "azurerm_role_assignment" "worker_storage_queue" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_windows_virtual_machine.worker.identity[0].principal_id
}
