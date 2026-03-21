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

# --- Resource Group ---

resource "azurerm_resource_group" "main" {
  name     = "${var.resource_prefix}-rg"
  location = var.location
}

# --- Storage Account (for file delivery to VM) ---

resource "azurerm_storage_account" "main" {
  name                     = "${var.resource_prefix}stor"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_container" "deploy" {
  name                  = "deploy"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

# Upload server.ts — content_md5 forces re-upload on file change
resource "azurerm_storage_blob" "server_ts" {
  name                   = "server.ts"
  storage_account_name   = azurerm_storage_account.main.name
  storage_container_name = azurerm_storage_container.deploy.name
  type                   = "Block"
  source                 = "${path.module}/../server.ts"
  content_md5            = filemd5("${path.module}/../server.ts")
}

# Upload index.html — content_md5 forces re-upload on file change
resource "azurerm_storage_blob" "index_html" {
  name                   = "index.html"
  storage_account_name   = azurerm_storage_account.main.name
  storage_container_name = azurerm_storage_container.deploy.name
  type                   = "Block"
  source                 = "${path.module}/../index.html"
  content_md5            = filemd5("${path.module}/../index.html")
}

# Upload bootstrap.ps1 — content_md5 forces re-upload on file change
resource "azurerm_storage_blob" "bootstrap" {
  name                   = "bootstrap.ps1"
  storage_account_name   = azurerm_storage_account.main.name
  storage_container_name = azurerm_storage_container.deploy.name
  type                   = "Block"
  source                 = "${path.module}/bootstrap.ps1"
  content_md5            = filemd5("${path.module}/bootstrap.ps1")
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

# --- Networking ---

resource "azurerm_virtual_network" "main" {
  name                = "${var.resource_prefix}-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_subnet" "main" {
  name                 = "${var.resource_prefix}-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_security_group" "main" {
  name                = "${var.resource_prefix}-nsg"
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
    name                       = "AllowRDP"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3389"
    source_address_prefix      = var.allowed_ip
    destination_address_prefix = "*"
  }
}

resource "azurerm_public_ip" "main" {
  name                = "${var.resource_prefix}-pip"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "main" {
  name                = "${var.resource_prefix}-nic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.main.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.main.id
  }
}

resource "azurerm_network_interface_security_group_association" "main" {
  network_interface_id      = azurerm_network_interface.main.id
  network_security_group_id = azurerm_network_security_group.main.id
}

# --- Windows VM ---

resource "azurerm_windows_virtual_machine" "main" {
  name                = "${var.resource_prefix}-vm"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  size                = var.vm_size
  admin_username      = var.admin_username
  admin_password      = var.admin_password

  network_interface_ids = [
    azurerm_network_interface.main.id,
  ]

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

# --- Bootstrap the VM via Custom Script Extension ---

resource "azurerm_virtual_machine_extension" "bootstrap" {
  name                       = "bootstrap"
  virtual_machine_id         = azurerm_windows_virtual_machine.main.id
  publisher                  = "Microsoft.Compute"
  type                       = "CustomScriptExtension"
  type_handler_version       = "1.10"
  auto_upgrade_minor_version = true

  depends_on = [
    azurerm_storage_blob.index_html,
    azurerm_storage_blob.server_ts,
    azurerm_storage_blob.bootstrap,
    azurerm_storage_blob.datadrivenlibs_zip,
  ]

  settings = jsonencode({
    fileUris = [
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/bootstrap.ps1",
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/index.html",
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/server.ts",
      "${azurerm_storage_account.main.primary_blob_endpoint}deploy/datadrivenlibs.zip"
    ]
    timestamp = timestamp()
  })

  protected_settings = jsonencode({
    storageAccountName = azurerm_storage_account.main.name
    storageAccountKey  = azurerm_storage_account.main.primary_access_key
    commandToExecute   = "powershell -ExecutionPolicy Unrestricted -File bootstrap.ps1 -Domain ${var.domain}"
  })
}
